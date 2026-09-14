/**
 * Turn session machinery (9-impl §1.4 `turn`/`commit`/`lock`/`oplog`):
 * lazily opened per producer agent, process-local turn mutex per workspace,
 * native-CAS commit at turn end, oplog + changelog + baseline flush, and
 * failure rollback by structured clone.
 *
 * Cross-process safety is the native CAS at commit (`replaceIfVersion`
 * guarded write); the mutex serializes AI turn windows inside one host.
 */

import { FsError, FsVersion, type FsTarget, type FsWriteIntent, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CicadaFormat } from '@deepseek-ai/dsh-cicada-format'
import { SCHEMATIC_FILE_NAME, TRUTH_VERSION, WORKSPACE_DIR } from '@deepseek-ai/dsh-cicada-format'
import type { SemanticModel } from '@deepseek-ai/dsh-cicada-deriver'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { posix } from 'node:path'

// Fs paths passed to the workspace service use the product's canonical
// slash-separated form; do not let the host OS rewrite them to backslashes.
const join = posix.join

import { baselineSnapshot, diffComponents, parseBaselineSnapshot, type ChangelogEntry } from './changelog.ts'
import { CicadaError } from './errors.ts'
import type { CicadaRuntimeChange } from './events.ts'
import { Model } from './file-model.ts'

export type WatchFactory = (path: string, listener: () => void) => FSWatcher

export interface TurnManagerOptions {
  onChange?: (change: CicadaRuntimeChange) => void
  watch?: WatchFactory
  onWatchError?: (error: unknown) => void
  /** Per-session sandbox policy stamped on the runtime's OWN fs mutations (the model-tool path resolves it itself). */
  policyFor?: (agent: Agent) => unknown
}

/** Minimal `fs` surface the turn needs (satisfied by `ctx.fs`). */
export interface FsApi {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<{ version: FsVersion; type: 'file' | 'directory' | 'other' } | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<FsWriteOutcome>
}

/** A turn-local operation: receives the live model and the workspace root. */
export type TurnOp<T> = (model: Model, workspaceRoot: string) => T

/** One performed op (oplog redo intent). */
export interface OpRecord {
  tool: string
  args: unknown
}

interface Turn {
  agentId: string
  workspace: string
  target: FsTarget
  baseline: FsVersion
  model: Model
  before: SemanticModel
  log: OpRecord[]
  releaseMutex: () => void
}

/** Canonical empty truth file seeded on first producer turn. */
export function emptySchematicText(): string {
  return [
    `(kicad_sch (version ${TRUTH_VERSION}) (generator "cicada") (generator_version "0.1")`,
    `  (uuid ${randomUUID()})`,
    ``,
    `  (lib_symbols)`,
    ``,
    `  (sheet_instances (path "/" (page "1"))))`,
    ``,
  ].join('\n')
}

/** Process-local per-workspace turn mutex (v1; CAS covers cross-process). */
class TurnMutex {
  private held = new Set<string>()
  private waiters = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]>()

  async acquire(workspace: string, timeoutMs = 30000): Promise<() => void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!this.held.has(workspace)) {
        this.held.add(workspace)
        let released = false
        return () => {
          if (released) return
          released = true
          this.held.delete(workspace)
          const next = this.waiters.get(workspace)?.shift()
          if (next !== undefined) {
            clearTimeout(next.timer)
            next.resolve()
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        const list = this.waiters.get(workspace) ?? []
        const remaining = Math.max(1, deadline - Date.now())
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            const current = this.waiters.get(workspace)
            if (current !== undefined) {
              const index = current.indexOf(waiter)
              if (index >= 0) current.splice(index, 1)
            }
            reject(new CicadaError('path_not_found', `workspace "${workspace}" is busy in another session`))
          }, remaining),
        }
        list.push(waiter)
        this.waiters.set(workspace, list)
      })
    }
  }
}

/** One server-side worksite turn owner per producer agent. */
export class TurnManager {
  private turns = new Map<string, Turn>()
  private mutex = new TurnMutex()
  private currentWorkspace: string | undefined
  private watchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | undefined }>()
  private readonly onChange: (change: CicadaRuntimeChange) => void
  private readonly watchFactory: WatchFactory
  private readonly onWatchError: (error: unknown) => void
  private readonly policyFor: ((agent: Agent) => unknown) | undefined
  private readonly watcherPolicy = new Map<string, unknown>()
  private reconcileInFlight = new Map<string, Promise<CicadaRuntimeChange | undefined>>()
  private readonly publishedVersions = new Map<string, string>()
  private readonly watchGeneration = new Map<string, number>()

  constructor(
    private readonly fs: FsApi,
    private readonly format: CicadaFormat,
    options: TurnManagerOptions = {},
  ) {
    this.onChange = options.onChange ?? (() => {})
    this.watchFactory = options.watch ?? ((path, listener) => watch(path, { persistent: false }, listener))
    this.onWatchError = options.onWatchError ?? (() => {})
    this.policyFor = options.policyFor
  }

  /** The workspace root of the turn currently executing (op-host resolution). */
  workspaceOf(): string | undefined {
    return this.currentWorkspace
  }

  /** Read-only view of a workspace (no turn mutex): open turn wins. */
  async readWorkspace(cwd: string): Promise<Model> {
    const open = [...this.turns.values()].find((turn) => turn.workspace === cwd)
    if (open !== undefined) return open.model
    const target = await this.fs.resolve(join('.cicada', 'schematic.cicada_sch'), { cwd })
    const info = await this.fs.stat(target)
    if (info === undefined) {
      return new Model(this.format.parse(emptySchematicText()))
    }
    return new Model(this.format.parse(await this.fs.readText(target)))
  }

  /** Start observing the hot schematic file for external editor writes. */
  async watchWorkspace(cwd: string, policy?: unknown): Promise<void> {
    if (this.watchers.has(cwd)) return
    this.watcherPolicy.set(cwd, policy)
    const generation = this.watchGeneration.get(cwd) ?? 0
    const target = await this.fs.resolve(join(WORKSPACE_DIR, SCHEMATIC_FILE_NAME), { cwd })
    if ((this.watchGeneration.get(cwd) ?? 0) !== generation || this.watchers.has(cwd)) return
    try {
      const watcher = this.watchFactory(target.displayPath, () => this.scheduleReconcile(cwd))
      watcher.on('error', error => this.onWatchError(error))
      this.watchers.set(cwd, { watcher, timer: undefined })
    } catch (error) {
      // Remote fs providers may expose a display path that is not watchable.
      // Runtime correctness remains available through reconcileWorkspace().
      this.onWatchError(error)
    }
  }

  /** Stop a workspace watcher when its last owning agent is disposed. */
  unwatchWorkspace(cwd: string): void {
    this.watchGeneration.set(cwd, (this.watchGeneration.get(cwd) ?? 0) + 1)
    this.watcherPolicy.delete(cwd)
    const state = this.watchers.get(cwd)
    if (state === undefined) return
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.watcher.close()
    this.watchers.delete(cwd)
  }

  /**
   * Compare the live schematic with the persisted view baseline. A version
   * change is consumed exactly once by advancing view.json; semantic changes
   * append one or more user_edit records before the baseline is advanced.
   */
  async reconcileWorkspace(cwd: string, policy?: unknown): Promise<CicadaRuntimeChange | undefined> {
    const active = this.reconcileInFlight.get(cwd)
    if (active !== undefined) return active
    const operation = this.withWorkspaceLock(cwd, () => this.reconcileWorkspaceOnce(cwd, policy))
    this.reconcileInFlight.set(cwd, operation)
    try {
      return await operation
    } finally {
      if (this.reconcileInFlight.get(cwd) === operation) this.reconcileInFlight.delete(cwd)
    }
  }

  private async withWorkspaceLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire(cwd)
    try {
      return await action()
    } finally {
      release()
    }
  }

  private async reconcileWorkspaceOnce(cwd: string, policy?: unknown): Promise<CicadaRuntimeChange | undefined> {
    const target = await this.fs.resolve(join(WORKSPACE_DIR, SCHEMATIC_FILE_NAME), { cwd })
    const info = await this.fs.stat(target)
    const fileText = info === undefined ? '' : await this.fs.readText(target)
    const model = new Model(this.format.parse(info === undefined ? emptySchematicText() : fileText))
    const baselineTarget = await this.resolveSidecarForWorkspace(cwd, 'view.json')
    const baselineInfo = await this.fs.stat(baselineTarget)
    const baseline = baselineInfo === undefined
      ? undefined
      : await this.readBaselineSnapshot(baselineTarget)
    const currentVersion = info === undefined ? 'absent' : String(info.version)
    this.publishedVersions.set(cwd, currentVersion)
    if (baseline?.baselineVersion === currentVersion) return undefined

    const summaries = baseline === undefined ? [] : diffComponents(baseline, model.view)
    const entries = await this.appendChangelog(cwd, summaries, 'user_edit', policy)
    await this.upsertWorkspace(cwd, 'view.json', JSON.stringify(baselineSnapshot(model.view, currentVersion), null, 1), policy)
    const change: CicadaRuntimeChange = {
      workspace: cwd,
      file: SCHEMATIC_FILE_NAME,
      origin: 'watcher',
      baselineVersion: currentVersion,
      baselineHash: createHash('sha256').update(fileText, 'utf8').digest('hex'),
      entries,
    }
    this.publish(change)
    return change
  }

  /** Keep view.json current at a conversation boundary, even with no AI op. */
  async advanceBaseline(cwd: string, policy?: unknown): Promise<CicadaRuntimeChange | undefined> {
    return this.reconcileWorkspace(cwd, policy)
  }

  /** Run one op in a per-agent turn transaction; failure leaves the model untouched. */
  async perform<T>(agent: Agent, record: OpRecord, op: TurnOp<T>): Promise<T> {
    const turn = await this.ensure(agent)
    const tx = new Model(structuredClone(turn.model.file))
    this.currentWorkspace = turn.workspace
    try {
      const result = op(tx, turn.workspace)
      turn.model = tx
      turn.log.push(record)
      return result
    } finally {
      this.currentWorkspace = undefined
    }
  }

  /** Begin (or lazily open) the turn for an agent. */
  async ensure(agent: Agent): Promise<Turn> {
    const existing = this.turns.get(agent.id)
    if (existing !== undefined) return existing
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      throw new CicadaError('path_not_found', 'the agent session has no working directory; cannot open a schematic')
    }
    const releaseMutex = await this.mutex.acquire(cwd)
    try {
      // A concurrent call for the same agent may have opened a turn while we
      // were waiting. Reuse it instead of replacing its transaction state.
      const afterAcquire = this.turns.get(agent.id)
      if (afterAcquire !== undefined) {
        releaseMutex()
        return afterAcquire
      }
      const target = await this.fs.resolve(join('.cicada', 'schematic.cicada_sch'), { cwd })
      const info = await this.fs.stat(target)
      // 首写（文件不存在时创建空 schematic）同样携带会话策略：else 分支的
      // stat/read 无副作用，而 createIfAbsent 是本次修复遗漏的第二个内部写
      //（K6 实测 place_symbol 首调即在此被拒）。
      const policy = this.policyFor?.(agent)
      let baseline: FsVersion
      let model: Model
      if (info === undefined) {
        const outcome = await this.fs.writeText(target, emptySchematicText(), { kind: 'createIfAbsent' }, undefined, policy)
        baseline = outcome.version
        model = new Model(this.format.parse(outcome.after))
      } else {
        baseline = info.version
        model = new Model(this.format.parse(await this.fs.readText(target)))
      }
      const turn: Turn = {
        agentId: agent.id,
        workspace: cwd,
        target,
        baseline,
        model,
        before: model.view,
        log: [],
        releaseMutex,
      }
      this.turns.set(agent.id, turn)
      void this.watchWorkspace(cwd)
      return turn
    } catch (error) {
      releaseMutex()
      throw error
    }
  }

  /**
   * Commit the turn: native-CAS write (single writer), then oplog +
   * changelog + baseline. A stale version raises `expected_net_mismatch` and
   * RESETS the turn from disk (uncommitted ops are discarded; the producer
   * re-reads and retries against the fresh file).
   */
  async commit(agent: Agent): Promise<void> {
    const turn = this.turns.get(agent.id)
    if (turn === undefined || turn.log.length === 0) {
      this.turns.delete(agent.id)
      turn?.releaseMutex()
      return
    }
    // The runtime's own mutations carry the agent session's standing policy:
    // without it the fs fence falls back to the DEPLOYMENT root and denies a
    // write under the session workspace (K6 实测 view.json 被拒)。
    const policy = this.policyFor?.(agent)
    try {
      // M1b 提交不覆盖：引擎（人类画布）可能在回合期间向文件 lib_symbols 新增了条目；
      // 提交前重读当前文件，把 model 缺失的条目并入（model 自有的条目优先），
      // 避免"写入即丢引擎加的东西"（用户 9-6 报告的同族问题，C++ 侧已修，这里补 TS 侧）。
      let merged = turn.model.file
      try {
        const currentText = await this.fs.readText(turn.target)
        const current = this.format.parse(currentText)
        const modelIds = new Set(merged.libSymbols.map((entry) => entry.libId))
        const extra = current.libSymbols.filter((entry) => !modelIds.has(entry.libId))
        if (extra.length > 0) {
          merged = { ...turn.model.file, libSymbols: [...merged.libSymbols, ...extra] }
          this.format.serialize(merged) // validate the merged file before writing
        }
      } catch {
        // 文件不可读/解析失败（首次提交前不存在等）：跳过合并，按原样提交
      }
      const outcome = await this.fs.writeText(
        turn.target,
        this.format.serialize(merged),
        { kind: 'replaceIfVersion', version: turn.baseline },
        undefined,
        policy,
      )
      await this.flushMeta(turn, outcome, policy)
      this.turns.delete(agent.id)
      turn.releaseMutex()
    } catch (error) {
      if (error instanceof FsError && error.code === 'FS_STALE_VERSION') {
        await this.reset(turn)
        throw new CicadaError('expected_net_mismatch', '图纸在修改期间被改过，请重读后再执行')
      }
      // The primary file may already be committed when a sidecar write fails.
      // Do not strand the workspace mutex: metadata can be repaired by the
      // next reconciliation, while a leaked lock would block all future work.
      this.turns.delete(agent.id)
      turn.releaseMutex()
      throw error
    }
  }

  /** Abort an open turn without committing (release memory + mutex). */
  release(agentId: string): void {
    const turn = this.turns.get(agentId)
    if (turn !== undefined) {
      this.turns.delete(agentId)
      turn.releaseMutex()
      if (![...this.turns.values()].some((candidate) => candidate.workspace === turn.workspace)) {
        this.unwatchWorkspace(turn.workspace)
      }
    }
  }

  /** Re-read the file after a stale CAS (fresh baseline; uncommitted ops dropped). */
  private async reset(turn: Turn): Promise<void> {
    const info = await this.fs.stat(turn.target)
    if (info === undefined) return
    const model = new Model(this.format.parse(await this.fs.readText(turn.target)))
    turn.model = model
    turn.before = model.view
    turn.baseline = info.version
    turn.log = []
  }

  private async flushMeta(turn: Turn, outcome: FsWriteOutcome, policy?: unknown): Promise<void> {
    if (turn.log.length > 0) {
      const lines = turn.log.map((entry) => JSON.stringify(entry))
      await this.appendLines(turn, 'oplog.jsonl', lines, policy)
    }
    const summaries = diffComponents(turn.before, turn.model.view)
    const entries = await this.appendChangelog(turn.workspace, summaries, 'ai_op', policy)
    await this.upsert(turn, 'view.json', JSON.stringify(baselineSnapshot(turn.model.view, String(outcome.version)), null, 1), policy)
    this.publish({
      workspace: turn.workspace,
      file: SCHEMATIC_FILE_NAME,
      origin: 'ai-write',
      baselineVersion: String(outcome.version),
      baselineHash: createHash('sha256').update(outcome.after, 'utf8').digest('hex'),
      entries,
    })
    this.publishedVersions.set(turn.workspace, String(outcome.version))
  }

  private async resolveSidecar(turn: Turn, name: string): Promise<FsTarget> {
    return this.resolveSidecarForWorkspace(turn.workspace, name)
  }

  /** Event consumers are advisory; a failing editor/UI listener must not leave a committed turn locked. */
  private publish(change: CicadaRuntimeChange): void {
    try {
      this.onChange(change)
    } catch (error) {
      this.onWatchError(error)
    }
  }

  private async resolveSidecarForWorkspace(workspace: string, name: string): Promise<FsTarget> {
    return this.fs.resolve(join(WORKSPACE_DIR, name), { cwd: workspace })
  }

  private async appendLines(turn: Turn, name: string, lines: string[], policy?: unknown): Promise<void> {
    const sidecar = await this.resolveSidecar(turn, name)
    const info = await this.fs.stat(sidecar)
    const existing = info === undefined ? '' : await this.fs.readText(sidecar)
    const next = existing === '' ? lines.map((line) => `${line}\n`).join('') : `${existing}${lines.map((line) => `${line}\n`).join('')}`
    await this.fs.writeText(sidecar, next, info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }, undefined, policy)
  }

  private async appendChangelog(workspace: string, summaries: string[], kind: ChangelogEntry['type'], policy?: unknown): Promise<ChangelogEntry[]> {
    if (summaries.length === 0) return []
    const sidecar = await this.resolveSidecarForWorkspace(workspace, 'changelog.jsonl')
    const info = await this.fs.stat(sidecar)
    const existing = info === undefined ? '' : await this.fs.readText(sidecar)
    let seq = 0
    for (const line of existing.split('\n')) {
      if (line.trim() === '') continue
      try {
        const value = JSON.parse(line) as { seq?: unknown }
        if (typeof value.seq === 'number' && Number.isSafeInteger(value.seq)) seq = Math.max(seq, value.seq)
      } catch {
        // Legacy or manually edited lines do not prevent appending new events.
      }
    }
    const entries: ChangelogEntry[] = summaries.map((summary, index) => ({
      seq: seq + index + 1,
      type: kind,
      tool: kind === 'user_edit' ? 'watcher' : 'turn',
      summary,
      at: Date.now(),
    }))
    const next = `${existing}${entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')}`
    await this.fs.writeText(sidecar, next, info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }, undefined, policy)
    return entries
  }

  private async upsert(turn: Turn, name: string, content: string, policy?: unknown): Promise<void> {
    const sidecar = await this.resolveSidecar(turn, name)
    await this.writeUpsert(sidecar, content, policy)
  }

  private async upsertWorkspace(workspace: string, name: string, content: string, policy?: unknown): Promise<void> {
    const sidecar = await this.resolveSidecarForWorkspace(workspace, name)
    await this.writeUpsert(sidecar, content, policy)
  }

  private async writeUpsert(sidecar: FsTarget, content: string, policy?: unknown): Promise<void> {
    const info = await this.fs.stat(sidecar)
    await this.fs.writeText(sidecar, content, info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }, undefined, policy)
  }

  /** Invalid or partially written baseline caches are recoverable state. */
  private async readBaselineSnapshot(target: FsTarget): Promise<ReturnType<typeof parseBaselineSnapshot>> {
    try {
      return parseBaselineSnapshot(JSON.parse(await this.fs.readText(target)))
    } catch {
      return undefined
    }
  }

  private scheduleReconcile(cwd: string): void {
    const state = this.watchers.get(cwd)
    if (state === undefined || state.timer !== undefined) return
    const timer = setTimeout(() => {
      state.timer = undefined
      void this.notifyWatcher(cwd).catch(error => this.onWatchError(error))
    }, 40)
    timer.unref?.()
    state.timer = timer
  }

  /** Notify the editor immediately, but defer semantic/user_edit consumption to pre-step. */
  private async notifyWatcher(cwd: string): Promise<void> {
    const target = await this.fs.resolve(join(WORKSPACE_DIR, SCHEMATIC_FILE_NAME), { cwd })
    const info = await this.fs.stat(target)
    const version = info === undefined ? 'absent' : String(info.version)
    if (this.publishedVersions.get(cwd) === version) return
    const text = info === undefined ? '' : await this.fs.readText(target)
    this.publish({
      workspace: cwd,
      file: SCHEMATIC_FILE_NAME,
      origin: 'watcher',
      baselineVersion: version,
      baselineHash: createHash('sha256').update(text, 'utf8').digest('hex'),
      entries: [],
    })
    this.publishedVersions.set(cwd, version)
  }
}
