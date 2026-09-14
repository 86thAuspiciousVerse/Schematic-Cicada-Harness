/**
 * `cicada-runtime` host plugin: the turn manager, producer role injection,
 * and the read-only inspect tools. The eight write tools are NOT registered
 * here — they enter the world only through the producer's scoped window
 * (see {@link ./roles.ts}).
 */

import { join } from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SemanticModel } from '@deepseek-ai/dsh-cicada-deriver'
import { WORKSPACE_DIR } from '@deepseek-ai/dsh-cicada-format'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { CicadaError } from './errors.ts'
import { createEngineClientFromEnv } from './env_engine_client.ts'
import { Model } from './file-model.ts'
import { datasheetShapeBlock, tailOf, toEngineBlock, type OpHost } from './ops.ts'

export type { DatasheetPinSource, OpHost } from './ops.ts'
import { PRODUCER_DENY, installScopedTools, isProducer, knowledgeDatasheetReadDenial, landscapeWriteDenial } from './roles.ts'
import { cicadaWriteTools, type CicadaReadHost, type CicadaToolHost } from './tools.ts'
import { TurnManager } from './turn.ts'
import type { CicadaRuntimeChange } from './events.ts'
export type { CicadaRuntimeChange } from './events.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Published after schematic/changelog/view sidecars have committed. */
    'cicada/runtime/changed'(payload: CicadaRuntimeChange): void
  }
}

/** The registered service (`ctx.cicadaRuntime`). */
export class CicadaRuntimeService {
  constructor(
    public readonly ctx: Context,
    public readonly manager: TurnManager,
  ) {}
}

/** Main + producer read-only inspect tools (coordinate-free semantic view). */
export function cicadaInspectTools(host: CicadaReadHost): ToolDefinition[] {
  return [
    defineTool({
      name: 'inspect_component',
      description: 'Inspect one component (or all components) of the current schematic semantic view.',
      parameters: {
        refdes: { type: 'string', description: 'Optional refdes; omit to list all components.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            components: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { refdes?: string }, exec) {
        const view = await host.perform(exec.agent, { tool: 'inspect_component', args }, (v) => v)
        const components = (args.refdes === undefined
          ? view.components
          : view.components.filter((component) => component.refdes === args.refdes))
          .map((component) => ({ refdes: component.refdes, value: component.value, lib_id: component.libId, pins: component.pins }))
        return { ok: true, components }
      },
    }),
    defineTool({
      name: 'inspect_net',
      description: 'Inspect nets of the current schematic semantic view (name + members).',
      parameters: {
        name: { type: 'string', description: 'Optional net name; omit to list all nets.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            nets: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { name?: string }, exec) {
        const view = await host.perform(exec.agent, { tool: 'inspect_net', args }, (v) => v)
        const nets = (args.name === undefined
          ? view.nets
          : view.nets.filter((net) => net.name === args.name))
          .map((net) => ({ name: net.name, members: net.members.map((member) => ({ refdes: member.refdes, pinName: member.pinName, physicalNumber: member.physicalNumber })) }))
        return { ok: true, nets }
      },
    }),
  ]
}

export const name = 'cicada-runtime'
export const inject = ['fs', 'cicadaFormat', 'cicadaKnowledge']

export function apply(ctx: Context): void {
  // The runtime's own fs mutations (schematic commit + view/changelog/oplog
  // sidecars) must carry the calling session's standing sandbox policy —
  // without it the fs fence resolves the DEPLOYMENT root and denies writes
  // under a session workspace (K6 实测 view.json 被拒)。The service is
  // optional: an unsandboxed deployment has no fence to satisfy.
  const policyFor = (agent: Agent): unknown =>
    ctx.get('sandboxPolicy')?.resolve({ session: agent.session })

  const manager = new TurnManager(ctx.fs, ctx.cicadaFormat, {
    onChange: change => ctx.emit('cicada/runtime/changed', change),
    onWatchError: error => ctx.logger.warn(`cicada-runtime watcher unavailable: ${String(error)}`),
    policyFor,
  })

  const knowledge = ctx.get('cicadaKnowledge')

  // 编辑器互斥锁（docs/05 §1）：bridge 提供 `cicadaEditorLock`（缺位 = 不取锁，回退安全）。
  // 策略在本插件：**回合进行中即锁**——`agent/pre-step` step1 取、回合收尾提交后放；
  // 将来放宽（例如只在写窗口锁）只改这两处调用点。
  interface EditorLockLike {
    acquireAgent(): unknown
    releaseAgent(): unknown
    /** false = 人侧正持锁（AI 写工具必须让路）。 */
    canAgentWrite(): boolean
  }
  const editorLock = (): EditorLockLike | undefined =>
    ctx.get('cicadaEditorLock') as EditorLockLike | undefined
  /** Turns currently holding the lock (acquire/release must pair per agent). */
  const lockHeld = new Set<string>()
  const acquireEditorLock = (agent: Agent): void => {
    const lock = editorLock()
    if (lock === undefined || lockHeld.has(agent.id)) return
    lockHeld.add(agent.id)
    lock.acquireAgent()
  }
  const releaseEditorLock = (agent: Agent): void => {
    if (!lockHeld.delete(agent.id)) return
    editorLock()?.releaseAgent()
  }

  // M1b 库道：引擎客户端（bridge 提供服务）→ 异步预热全部符号几何到缓存。
  // 引擎不可达/未连 → 库道降级（opHost.lib 保持 undefined；tools 走 kind/part_number）。
  interface LibEngineClient {
    listSymbols(): Promise<string[]>
    listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]>
    getSymbol(name: string): Promise<
      { libId?: string; name: string; pins: readonly { number: string; name: string; x: number; y: number; angle: number }[] } | undefined
    >
    synthesize(block: {
      name: string
      refPrefix?: string
      description?: string
      pins: readonly { number: string; name: string; electrical: string; side?: string }[]
    }): Promise<{ ok: boolean; libId?: string; warnings?: string[]; error?: string }>
  }
  const engineClient = (ctx.get('cicadaEngineClient') as LibEngineClient | undefined)
    ?? (createEngineClientFromEnv() as LibEngineClient | undefined)
  const libCache = new Map<string, {
    /** Canonical library key from the engine (`category:name`). */
    libId: string
    name: string
    pins: readonly { number: string; name: string; x: number; y: number; angle: number }[]
  }>()
  /** Resolves when the library cache is warm (or immediately without an engine client). */
  let libReady: Promise<void> = Promise.resolve()
  if (engineClient !== undefined) {
    // 预热按目录键取几何（`/lib/get` 键寻址；name-only 对内置件不可靠），缓存键 = 尾段名。
    // 预热完成前不放行写工具：库道放置读的是这份缓存（否则首回合可能空缓存 miss）。
    libReady = engineClient
      .listLibrary()
      .then(async (entries) => {
        for (const entry of entries) {
          const sym = await engineClient.getSymbol(entry.libId)
          if (sym === undefined) continue
          // 引擎 /lib/get 是 IU；runtime 以 G 为纲（0.01mm = 100 IU）→ /100
          libCache.set(entry.name, {
            libId: sym.libId ?? entry.libId,
            name: sym.name,
            pins: sym.pins.map((p) => ({
              number: p.number,
              name: p.name,
              x: Math.round(p.x / 100),
              y: Math.round(p.y / 100),
              angle: p.angle ?? 0,
            })),
          })
        }
      })
      .catch((error) => ctx.logger.warn(`cicada-engine library unavailable: ${String(error)}`))
  }

  const opHost: OpHost = {
    datasheet: (part) => {
      const workspace = manager.workspaceOf()
      if (workspace === undefined || knowledge === undefined) return undefined
      return knowledge.workspaceDatasheetPins(workspace, part)
    },
    ...(engineClient === undefined
      ? {}
      : {
          lib: {
            get: (name: string) => libCache.get(name),
            list: (): string[] => [...libCache.keys()],
            synthesize: async (block) => {
              const res = await engineClient.synthesize(block)
              return res
            },
          },
        }),
  }

  const writeHost: CicadaToolHost = {
    async perform<T>(agent: Agent | undefined, record: { tool: string; args: unknown }, op: (model: Model) => T): Promise<T> {
      if (agent === undefined) throw new CicadaError('path_not_found', 'no agent context for the producer tool')
      // 互斥锁（docs/05 §1）：人侧正在画布上编辑 → 写工具让路（工具错误结果，不落盘）。
      const lock = editorLock()
      if (lock !== undefined && !lock.canAgentWrite()) {
        throw new CicadaError('editor_busy', '编辑器正在编辑，请稍后')
      }
      if (engineClient !== undefined) {
        await libReady
        const args = record.args as { lib_id?: string; source_ids?: string[]; part_number?: string } | undefined
        // 工作区取自 agent cwd（perform 内才设置 currentWorkspace——hook 在其之前运行）
        const cwd = agent.session.header.cwd
        // M1e-1 自动查缺（runtime 内部；producer 面不可见——docs/09 §5）：
        // lib_id miss → workspace `datasheet/<part>/shape.json`（优先拍板）→ 引擎合成入库 → 缓存刷新。
        // 合成失败 loud；无形状块则交给 place_symbol 的正常 miss 报错（列出可用符号）。
        if (args?.lib_id !== undefined) {
          const key = args.lib_id
          const hit = await engineClient.getSymbol(key)
          if (hit === undefined) {
            const name = tailOf(key)
            // 查缺源优先次序（docs/09 §5）：datasheet/<name>/shape.json →
            // 工作区根 shape.json（校验块内 name 一致，防张冠李戴）
            const block = cwd !== undefined && knowledge !== undefined
              ? (knowledge.workspaceShapeBlock(cwd, name) ?? knowledge.workspaceRootShapeBlock(cwd, name))
              : undefined
            if (block !== undefined) {
              // 块的 `name` 只是建议：目录/键才是件的权威（缺陷 4，2026-09-13——
              // AMS1117-3.3 的块写成 AMS1117，引擎就会铸出 IC:AMS1117 去顶撞同名
              // 精选符号）。统一按请求件号定名，写错名的块由审计在发布口拦下。
              if (String(block.name ?? '') !== name) {
                ctx.logger.warn(`cicada-runtime: shape block for "${name}" names itself "${String(block.name)}" — synthesizing as "${name}"`)
              }
              const res = await engineClient.synthesize({ ...toEngineBlock(block), name })
              if (!res.ok || res.libId === undefined) {
                throw new CicadaError('symbol_unsupported', `engine synthesize failed: ${res.error ?? 'unknown error'}`)
              }
              const got = await engineClient.getSymbol(res.libId)
              if (got !== undefined) {
                // 引擎 /lib/get 是 IU；runtime 以 G 为纲 → /100（与预热缓存同规则）
                libCache.set(name, {
                  libId: got.libId ?? res.libId,
                  name: got.name,
                  pins: got.pins.map((p) => ({
                    number: p.number,
                    name: p.name,
                    x: Math.round(p.x / 100),
                    y: Math.round(p.y / 100),
                    angle: p.angle ?? 0,
                  })),
                })
              }
            }
          }
        }
        // M1e-1：datasheet 道（知识记录）→ 形状块 → 引擎 /lib/synthesize 预热用户库（几何引擎定；
        // 引擎在场但拒绝 = 形状块/引擎问题 → loud 失败，不静默降级）。
        const datasheetLane = args?.source_ids?.some((id) => /^detail\/[^/]+\.json$/.test(id)) ?? false
        const part = args?.part_number
        if (datasheetLane && part !== undefined && part !== '') {
          if (cwd !== undefined && knowledge !== undefined) {
            const source = knowledge.workspaceDatasheetPins(cwd, part)
            if (source !== undefined) {
              const block = datasheetShapeBlock(part, source)
              const res = await engineClient.synthesize(block)
              if (!res.ok || res.libId === undefined) {
                throw new CicadaError('symbol_unsupported', `engine synthesize failed: ${res.error ?? 'unknown error'}`)
              }
            }
          }
        }
      }
      return manager.perform(agent, record, (model) => op(model))
    },
  }
  const readHost: CicadaReadHost = {
    async perform<T>(agent: Agent | undefined, _record: { tool: string; args: unknown }, op: (view: SemanticModel) => T): Promise<T> {
      if (agent === undefined) throw new CicadaError('path_not_found', 'no agent context for the inspector')
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new CicadaError('path_not_found', 'the agent session has no working directory')
      return op((await manager.readWorkspace(cwd)).view)
    },
  }

  const inspectTools = cicadaInspectTools(readHost)
  const writeTools = cicadaWriteTools(writeHost, opHost)
  const producerReadTools: readonly ToolDefinition[] = knowledge?.producerReadToolDefinitions({
    // The producer's own session cwd is the workspace: its datasheet readers run
    // BEFORE any write opens a turn, so a turn-scoped lookup would answer
    // "no workspace" (the open turn stays the fallback for an unusual caller).
    workspaceRoot: (agent?: { session: { header: { cwd?: string } } }) => agent?.session.header.cwd ?? manager.workspaceOf(),
  }) ?? []

  // M1e-1 库目录工具（只读、全局可见）：全量目录（libId/name/category/pins）。
  // 语义 = 全量目录（无参、无过滤；AI 自行按 category/name 筛）。"精确有没有"不暴露——
  // miss 由 runtime 自动查缺处理（shape.json 优先 → 引擎合成入库），AI 无需也不应知道。
  const libraryTools: ToolDefinition[] = engineClient === undefined ? [] : [
    defineTool({
      name: 'list_library_symbols',
      description: 'Full catalog of loaded library symbols (builtin + curated + user library): '
        + 'each entry is {libId, name, category, pins}. No filtering — the AI picks by category/name. '
        + 'Place a symbol via place_symbol(lib_id=…); a missing lib_id is resolved automatically '
        + '(engine library → workspace datasheet shape.json → engine synthesis into the user library).',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            symbols: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(): Promise<{ ok: boolean; symbols: { libId: string; name: string; category: string; pins: number }[] }> {
        return { ok: true, symbols: await engineClient.listLibrary() }
      },
    }),
  ]

  const globalTools = ctx.get('tools')
  if (globalTools !== undefined) {
    for (const definition of [...inspectTools, ...libraryTools]) globalTools.register(definition)
  }

  /**
   * Last landscape revision reported per workspace, so one revision produces
   * one verdict (a fixable violation must not nag every turn).
   */
  const landscapeSeen = new Map<string, string>()

  /**
   * Knowledge-landscape gate (docs/05 §8): the knowledge agent's
   * `design_intent.json` is validated as soon as it lands, and the MAIN agent
   * gets the verdict inside the same step — the violations to fix, or the
   * datasheet lane the gate extracted. Subagents mid-cascade never see it.
   */
  const landscapeNotice = (agent: Agent, cwd: string): ReturnType<typeof createUserMessage> | undefined => {
    if (isProducer(agent) || agent.session.header.parentSession !== undefined) return undefined
    const knowledge = ctx.get('cicadaKnowledge')
    if (knowledge === undefined) return undefined
    const check = knowledge.checkLandscape(join(cwd, WORKSPACE_DIR))
    if (check.state === 'absent') return undefined
    if (landscapeSeen.get(cwd) === check.hash) return undefined
    landscapeSeen.set(cwd, check.hash)
    const file = `${WORKSPACE_DIR}/${check.path.split(/[\\/]/).pop() ?? check.path}`
    const text = check.state === 'ok'
      ? `知识图景已通过校验（${file}）：需要 datasheet 的部件 = ${check.datasheetRequired.length === 0 ? '（无）' : check.datasheetRequired.join('、')}。逐个 datasheet_library_check，命中就 datasheet_library_copy 复用，未命中派 datasheet 子代理。`
      : `知识图景校验未通过（${file}）：\n${(check.violations as string[]).map((violation: string) => `- ${violation}`).join('\n')}\n修好这些问题再走 datasheet 道（派单闸门）。`
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-cicada-runtime' },
    })
  }

  const install = (agent: Agent): void => {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined) void manager.watchWorkspace(cwd, policyFor(agent))
    if (!isProducer(agent)) return
    installScopedTools(agent, [...writeTools, ...producerReadTools], PRODUCER_DENY)
    // Commit at the turn boundary (awaited by the loop before the boundary commits).
    agent.ctx.on('agent/turn-stopping', async () => {
      try {
        await manager.commit(agent)
      } catch (error) {
        ctx.logger.error(`cicada-runtime: turn commit failed for ${agent.id}`, error)
      } finally {
        // 解锁在提交落地之后（docs/05 §1 帧序：先 canvas.refresh 后 lock=idle）。
        releaseEditorLock(agent)
      }
    })
  }

  for (const agent of ctx.get('agents')?.list() ?? []) install(agent)
  // ⑦ 机械闸门（2026-09-13）：图景的**唯一作者**是 knowledge 子代理。main 手改图景曾是
  // 实测行为（accept 项目的 FB-07 就是 main 用 edit 写进去的），散文约束拦不住，所以
  // 在工具执行前直接拒绝：根会话（main）对 `.cicada/design_intent.json` 的 write/edit。
  // 要改图景 → send_message 让 knowledge 子代理 refine。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const denial = landscapeWriteDenial(exec.agent, exec.name, exec.arguments)
      ?? knowledgeDatasheetReadDenial(exec.agent, exec.name, exec.arguments)
    return denial === undefined ? next() : { kind: 'deny', reason: denial }
  })

  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const cwd = agent.session.header.cwd
    manager.release(agent.id)
    releaseEditorLock(agent)
    if (cwd !== undefined && !ctx.get('agents')?.list().some(candidate => candidate.session.header.cwd === cwd)) {
      manager.unwatchWorkspace(cwd)
      landscapeSeen.delete(cwd)
    }
  })

  // Reconcile external editor writes at the beginning of every dialogue turn.
  // The injected message is part of the current step, so it is durable and
  // visible to the main agent without waking a second follow-up turn.
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    if (step !== 1 || decision.kind !== 'enter') return decision
    // 锁：回合真正开始（step1 enter）即取；人侧持锁会被抢占（用户已发消息）。
    acquireEditorLock(agent)
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return decision
    const messages = [...decision.messages]
    const change = await manager.reconcileWorkspace(cwd, policyFor(agent))
    if (change !== undefined && change.entries.length > 0) {
      const summary = change.entries.map(entry => entry.summary).join('；')
      messages.push(createUserMessage({
        content: [{ type: 'text', text: `检测到画布或文件被手工修改：${summary}\n当前图纸已重新建立基线。` }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-cicada-runtime' },
      }))
    }
    const landscape = landscapeNotice(agent, cwd)
    if (landscape !== undefined) messages.push(landscape)
    return messages.length === decision.messages.length ? decision : { ...decision, messages }
  })

  // A no-op dialogue still advances the baseline. AI producer commits publish
  // their own change before this listener observes the next boundary.
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (isProducer(agent)) return
    const cwd = agent.session.header.cwd
    if (cwd !== undefined) await manager.advanceBaseline(cwd, policyFor(agent))
    releaseEditorLock(agent)
  })

  ctx.effect(() => ctx.provide('cicadaRuntime', new CicadaRuntimeService(ctx, manager)))
}
