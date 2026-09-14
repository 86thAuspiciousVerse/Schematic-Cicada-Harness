/**
 * `cicada-editor-bridge`: the editor control plane host plugin (9-impl §1.8).
 *
 * Registers the `/cicada/editor` prefix route (selection injection + state
 * snapshot) and the `/cicada/editor/ws` upgrade route (downlink), mints the
 * process-lifetime editor token, prints `cicada-editor: <port> <token>` once
 * after the Loader settles, and forwards every accepted selection to the
 * webui canvas mirror through the `cicada/editor/selection` Remote-whitelist
 * event.
 *
 * Injection (P6 定案 G-P6-1): target session = explicit request `sessionId` →
 * config `mainSessionId` → root agent; the injection is one plugin-source
 * user message queued with `Agent.followup` (wakes the driver), plus the
 * selection event and the WS `selection.confirm` receipt.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader' // Context.loader merge (settle gate)
import type {} from '@deepseek-ai/dsh-host-webserver' // Context.webServer merge
import type {} from '@deepseek-ai/dsh-fs' // Context.fs merge
import type {} from '@deepseek-ai/dsh-session' // Context.sessions merge
import type {} from '@deepseek-ai/dsh-agent' // Context.agents merge
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SCHEMATIC_FILE_NAME, WORKSPACE_DIR } from '@deepseek-ai/dsh-cicada-format'
import { EDITOR_PATH_PREFIX, type EditorDownlink, type EngineSyncResponse, type SelectionItem } from './contract.ts'
import { createEditorLock } from './lock.ts'
import { createEngineClient } from './engine_client.ts'
import { createEditorRouteHandler, type EditorBridgeDeps, type StateSessionRef } from './routes.ts'
import { createWsBridge, type WsBridge } from './ws.ts'
import { announce, newToken, tokenMatches } from './token.ts'
import type { RuntimeChangeEvent } from './types.ts'

/** Default request-body byte limit for POST /selection. */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024

/** The plugin source stamp on injected messages (K10: distinguishes plugin input from user input). */
export const BRIDGE_SOURCE = '@deepseek-ai/dsh-cicada-editor-bridge'

/** Bridge config (P6 定案 G-P6-6). */
export interface Config {
  /** Non-loopback authorities past the trust fence; loopback is implicitly trusted. */
  trustedHosts?: string[]
  /** Fixed injection target session (overrides root-agent resolution). */
  mainSessionId?: string
  /** POST body byte limit; past it the request is refused 413. */
  maxRequestBodyBytes?: number
}

/** Once-per-root stdout guard (web-app `ANNOUNCED_ROOTS` pattern). */
const ANNOUNCED_ROOTS = new Set<unknown>()

/**
 * Product brand icon (favicon / Edge app-window icon). The launcher points
 * `CICADA_BRAND_ICON` at the shipped asset; the bytes are cached after the
 * first request, and a missing/unset path degrades to 404 (the page keeps the
 * shell's default icon).
 */
const BRAND_ICON_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}
const brandAssetCache = new Map<string, { body: Buffer; contentType: string } | undefined>()
function readBrandAsset(envName: string): { body: Buffer; contentType: string } | undefined {
  const cached = brandAssetCache.get(envName)
  if (cached !== undefined || brandAssetCache.has(envName)) return cached
  const path = typeof process !== 'undefined' ? process.env[envName] : undefined
  if (path === undefined || path === '') {
    brandAssetCache.set(envName, undefined)
    return undefined
  }
  try {
    const contentType = BRAND_ICON_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const asset = { body: readFileSync(path), contentType }
    brandAssetCache.set(envName, asset)
    return asset
  } catch {
    brandAssetCache.set(envName, undefined)
    return undefined
  }
}

/** Deferred selection batches keyed by target session id (`attachNextTurn`; replaced per right-click). */
const pendingBySession = new Map<SessionId, SelectionItem[]>()

/**
 * Push one selection summary into an agent's next-step inbox as plugin source
 * (DSH queue projection: plugin-source next-step messages surface as
 * `placement: 'context'` — system context for the model, never a chat item).
 */
function enqueueSelectionMessage(agent: Agent, text: string): void {
  agent.inbox.prepend('next-step', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: BRIDGE_SOURCE },
  }))
}

function enqueueSelectionContext(
  ctx: Context,
  sessionId: SessionId,
  selection: SelectionItem[],
): void {
  const agent = ctx.agents.get(sessionId)
  if (agent !== undefined) {
    enqueueSelectionMessage(agent, summarizeSelection(selection))
  } else {
    pendingBySession.set(sessionId, selection)
  }
}

export const name = 'cicada-editor-bridge'

/** Required services: webserver (routes), fs (baseline hash), agents (injection target). */
export const inject = ['webServer', 'fs', 'agents']

export function apply(ctx: Context, config: Config = {}): void {
  const token = newToken()
  const trustedHosts = config.trustedHosts ?? []
  const engineFromEnv = (): { port: number; token: string } | undefined => {
    const url = typeof process !== 'undefined' ? process.env.CICADA_ENGINE_URL : undefined
    const engineToken = typeof process !== 'undefined' ? process.env.CICADA_ENGINE_TOKEN : undefined
    if (url === undefined || engineToken === undefined) return undefined
    const port = Number(url.match(/:([0-9]+)\s*$/)?.[1] ?? '')
    if (!Number.isFinite(port) || port <= 0) return undefined
    return { port, token: engineToken }
  }
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  // Launcher-provided project (docs/04 §5.2); consumed by the first reader.
  let pendingInitialWorkspace: string | undefined =
    typeof process !== 'undefined' && process.env.CICADA_INITIAL_WORKSPACE !== undefined
      && process.env.CICADA_INITIAL_WORKSPACE !== ''
      ? process.env.CICADA_INITIAL_WORKSPACE
      : undefined

  let wsBridge: WsBridge | undefined
  // 锁权威（docs/05 §1）：纯状态机 + `lock` 帧 + 人侧租约；**"何时算 agent 在操作"
  // 由 runtime 决定**（回合首步 acquireAgent、提交落地后 releaseAgent），
  // 将来放宽语义只动 runtime 调用点，本模块不变。
  const lock = createEditorLock({
    onMode: snapshot => { wsBridge?.broadcast({ type: 'lock', mode: snapshot.mode }) },
  })
  ctx.effect(() => {
    const dispose = ctx.provide('cicadaEditorLock', lock)
    return () => { dispose(); lock.dispose() }
  }, 'cicada-editor-bridge: cicadaEditorLock')
  // 引擎端点（launcher 注入 CICADA_ENGINE_URL/TOKEN）；缺省 = 编辑器控制面仍可用，引擎道降级。
  const engineEndpoint = engineFromEnv()
  const deps: EditorBridgeDeps = {
    trustedHosts,
    matchesToken: presented => tokenMatches(presented ?? '', token.token),
    resolveSession: requested => resolveSession(ctx, config.mainSessionId, requested),
    readStateSession: async () => {
      // Live target first (same rule as injection), then the persisted-corpus
      // fallback (newest first): the editor needs cwd/file for canvas refresh
      // even before the user resumes the session under a fresh host. The live
      // `ctx.sessions` store is empty for parked sessions, so the fallback
      // must query the persistence corpus (K6 实测: /state 报无会话 though
      // the session store already carries the record).
      const live = resolveSession(ctx, config.mainSessionId, undefined)
      if (live !== undefined) return { id: live.id, header: live.header }
      const query = ctx.get('sessionQuery') as
        | { listSessions?: () => Promise<{ header: { cwd?: string; id: string } }[]> }
        | undefined
      const records = await query?.listSessions?.() ?? []
      const record = records.find(r => r.header.cwd !== undefined)
      return record === undefined ? undefined : { id: record.header.id, header: record.header }
    },
    queueSelection: (sessionId, selection) => {
      // 注入 = next-step 队列 + plugin 源 → DSH 语义 placement:'context'
      // （系统上下文：进模型输入、不占对话列表；与用户消息同 step 边界消费）。
      // 冷态（agent 未 materialize）→ pendingBySession 由 agent/created flush。
      enqueueSelectionContext(ctx, sessionId as SessionId, selection)
      ctx.emit('cicada/editor/selection', { sessionId, selection })
      wsBridge?.broadcast({ type: 'selection.confirm', sessionId, selection })
    },
    injectSelection: (session, selection) => {
      injectSelection(ctx, session, selection, wsBridge)
    },
    readBaseline: session => readBaseline(ctx, session),
    syncEngineDocument: async (sessionId) => {
      const target = await syncTargetSession(sessionId)
      if (target === undefined) return { ok: false, reason: 'no-session' }
      return await syncEngineDocument(target.cwd, target.id)
    },
    enterEdit: () => {
      const result = lock.acquireHuman()
      return { ok: result.ok, mode: result.snapshot.mode }
    },
    leaveEdit: () => ({ ok: true, mode: lock.releaseHuman().mode }),
    lockMode: () => lock.snapshot().mode,
    // The launcher passes the project the user clicked as CICADA_INITIAL_WORKSPACE
    // (docs/04 §5.2). Handing it out exactly once keeps "start into this project"
    // a per-launch action: a page reload must not open another session.
    takeInitialWorkspace: () => {
      const path = pendingInitialWorkspace
      pendingInitialWorkspace = undefined
      return path
    },
    brandIcon: () => readBrandAsset('CICADA_BRAND_ICON'),
    brandMark: () => readBrandAsset('CICADA_BRAND_MARK'),
    port: () => ctx.webServer.port,
    ...(engineEndpoint === undefined ? {} : { engine: engineEndpoint }),
    schematicFileName: SCHEMATIC_FILE_NAME,
    maxRequestBodyBytes,
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: EDITOR_PATH_PREFIX,
    handler: createEditorRouteHandler(deps),
  }), 'cicada-editor-bridge: /cicada/editor routes')

  // M1b 库道 + M1c 工作区跟随：host 环境变量注入引擎地址 → 单一 client 实例。
  // 缺省（无环境变量/引擎不可达）→ undefined（runtime 降级；跟随跳过）。
  const engineUrl = typeof process !== 'undefined' ? process.env.CICADA_ENGINE_URL : undefined
  const engineToken = typeof process !== 'undefined' ? process.env.CICADA_ENGINE_TOKEN : undefined
  const engineClient = (engineUrl !== undefined && engineUrl !== '' && engineToken !== undefined)
    ? createEngineClient(engineUrl, engineToken)
    : undefined
  if (engineClient !== undefined) {
    ctx.effect(() => ctx.provide('cicadaEngineClient', engineClient), 'cicada-editor-bridge: cicadaEngineClient')
  }

  ctx.effect(() => {
    const { bridge, route } = createWsBridge({
      trustedHosts,
      matchesToken: deps.matchesToken,
      port: deps.port,
    })
    wsBridge = bridge
    const unregister = ctx.webServer.registerUpgrade(route)
    return () => {
      unregister()
      bridge.dispose()
    }
  }, 'cicada-editor-bridge: /cicada/editor/ws')

  ctx.on('cicada/runtime/changed', (change) => {
    publishRuntimeChange(wsBridge, change)
  })

  // Engine document = the session's workspace: `{cwd}/.cicada/schematic.cicada_sch`.
  // Two triggers, both VERIFIED against the engine's current document (a path
  // cache alone cannot heal a restarted engine, an earlier failed load, or a
  // manual /document — 2026-09-08 画布空白缺陷根因):
  //   ① the canvas asks on mount / after a conflict (POST /canvas/sync),
  //   ② every user turn starts (agent/pre-step step 1, workspace switcher).
  // Failures are loud (warn) and never silently leave the engine on the wrong
  // document; the engine itself creates the truth file when the workspace has
  // none yet (docs/02 §3 /document).
  const engineSessionDoc = (cwd: string | undefined): string | undefined =>
    cwd === undefined || cwd === ''
      ? undefined
      : `${cwd.replaceAll('\\', '/')}/.cicada/schematic.cicada_sch`
  const normPath = (path: string): string => path.replaceAll('\\', '/').toLowerCase()
  const listPersistedSessions = async (): Promise<{ header: { cwd?: string; id: string } }[]> => {
    const query = ctx.get('sessionQuery') as
      | { listSessions?: () => Promise<{ header: { cwd?: string; id: string } }[]> }
      | undefined
    return await query?.listSessions?.() ?? []
  }
  const syncEngineDocument = async (
    cwd: string | undefined,
    sessionId?: string,
  ): Promise<EngineSyncResponse> => {
    const withSession = <T extends object>(value: T): T & { sessionId?: string } =>
      sessionId === undefined ? value : { ...value, sessionId }
    if (engineClient === undefined) return withSession({ ok: false, reason: 'no-engine' as const })
    const doc = engineSessionDoc(cwd)
    if (doc === undefined) return withSession({ ok: false, reason: 'no-workspace' as const })
    const current = await engineClient.currentDocument()
    if (current !== undefined && normPath(current) === normPath(doc)) {
      return withSession({ ok: true, file: doc, ...(cwd === undefined ? {} : { cwd }) })
    }
    const result = await engineClient.setDocument(doc)
    if (result.ok !== true) {
      ctx.logger.warn(`cicada-editor-bridge: engine document sync failed (${doc}): ${result.error ?? 'unknown error'}`)
      return withSession({
        ok: false,
        file: doc,
        ...(cwd === undefined ? {} : { cwd }),
        reason: 'engine-error' as const,
        ...(result.error === undefined ? {} : { error: result.error }),
      })
    }
    ctx.logger.info(`cicada-editor-bridge: engine document -> ${doc}`)
    wsBridge?.broadcast({ type: 'canvas.refresh', file: SCHEMATIC_FILE_NAME, reason: 'ai-write' })
    return withSession({ ok: true, file: doc, ...(cwd === undefined ? {} : { cwd }) })
  }
  /** Resolve a session's workspace for the sync endpoint (explicit id → live main → newest record). */
  const syncTargetSession = async (
    requested?: string,
  ): Promise<{ id: string; cwd?: string } | undefined> => {
    const ref = (id: string, cwd: string | undefined): { id: string; cwd?: string } =>
      cwd === undefined ? { id } : { id, cwd }
    if (requested !== undefined) {
      const live = ctx.agents.get(requested as SessionId)
      if (live !== undefined) return ref(live.session.id, live.session.header.cwd)
      const record = (await listPersistedSessions()).find(entry => entry.header.id === requested)
      if (record !== undefined) return ref(record.header.id, record.header.cwd)
    }
    const liveMain = resolveSession(ctx, config.mainSessionId, undefined)
    if (liveMain !== undefined) return ref(liveMain.id, liveMain.header.cwd)
    const newest = (await listPersistedSessions()).find(entry => entry.header.cwd !== undefined)
    return newest === undefined ? undefined : ref(newest.header.id, newest.header.cwd)
  }
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    if (step !== 1 || decision.kind !== 'enter') return decision
    await syncEngineDocument(agent.session.header.cwd, agent.session.id)
    return decision
  })

  // Deferred attachment (右键"加入到上下文"): the queued batch rides the
  // inbox (`agent/inbox/spliced` 持久化事件, 模型可见 ⟺ 日志可重建 由构造满足),
  // so it joins the next user turn of the TARGET session like a normal user
  // message — no `agent/pre-step` mutation of decision messages (that path
  // fails the harness's model-visible/logged assertion). Cold sessions (agent
  // not materialized yet) keep the batch in `pendingBySession` until their
  // agent materializes (`agent/created` flush below).
  const flushPending = (agent: Agent): void => {
    const pending = pendingBySession.get(agent.session.id)
    if (pending === undefined) return
    pendingBySession.delete(agent.session.id)
    enqueueSelectionMessage(agent, summarizeSelection(pending))
  }
  for (const agent of (ctx.get('agents') as { list?: () => Agent[] } | undefined)?.list?.() ?? []) flushPending(agent)
  ctx.on('agent/created', ({ agent }) => flushPending(agent))

  // Readiness line: only after the Loader settles is `webServer.port` defined
  // (K8; web-app `index.ts:262-306` timing). A hand-built tree without a
  // Loader is already complete.
  const settled = ctx.get('loader')?.await()
  const announceReady = (): void => {
    if (ANNOUNCED_ROOTS.has(ctx.root)) return
    ANNOUNCED_ROOTS.add(ctx.root)
    announce(ctx.webServer.port, token.token)
  }
  if (settled === undefined) announceReady()
  else {
    void settled.then(() => {
      if (ctx.get('webServer') !== undefined) announceReady()
    }, () => {})
  }
}

/** Map one committed runtime change to the editor's ordered downlink frames. */
export function publishRuntimeChange(bridge: WsBridge | undefined, change: RuntimeChangeEvent): void {
  if (bridge === undefined) return
  if (change.entries.length === 0) {
    bridge.broadcast({ type: 'canvas.refresh', file: change.file, reason: change.origin })
    return
  }
  for (const entry of change.entries) {
    if (entry.type === 'datasheet_update') continue
    const frame: EditorDownlink = {
      type: 'changelog',
      seq: entry.seq ?? 0,
      kind: entry.type,
      summary: entry.summary,
      baselineHash: change.baselineHash,
    }
    bridge.broadcast(frame)
  }
  bridge.broadcast({ type: 'baseline', file: change.file, baselineHash: change.baselineHash })
  bridge.broadcast({ type: 'canvas.refresh', file: change.file, reason: change.origin })
}

/**
 * Resolve the injection target: explicit request id → config `mainSessionId` →
 * first root agent (the main agent is a root; P6 定案 G-P6-1). Only a LIVE
 * agent's session is a valid target — `followup` needs the live handle.
 * @param ctx - host context.
 * @param configured - config `mainSessionId`, when set.
 * @param requested - explicit request `sessionId`, when present.
 * @returns the live agent's session, or undefined when no live agent matches.
 */
function resolveSession(ctx: Context, configured: string | undefined, requested?: string): Session | undefined {
  const id = requested ?? configured
  if (id !== undefined) {
    return ctx.agents.get(id as SessionId)?.session
  }
  return ctx.agents.roots()[0]?.session
}

/**
 * Accept one selection: queue it for the next user turn (`attachNextTurn` —
 * the K6 右键"加入到上下文" flow; prepended to the same step, no 插话) or
 * inject immediately (wakes the driver), then emit the canvas-mirror event
 * and push the WS receipt.
 * @param ctx - host context.
 * @param session - the resolved target session.
 * @param selection - validated selected items.
 * @param bridge - the live ws bridge, when mounted (selection.confirm receipt).
 * @param attachNextTurn - queue for the next user turn instead of interrupting.
 */
function injectSelection(
  ctx: Context,
  session: Session,
  selection: SelectionItem[],
  bridge: WsBridge | undefined,
): void {
  // Immediate injection: the agent MUST be live — the batch is prepended into
  // the next-step boundary as plugin source (placement 'context': system
  // context for the running/next step, never a chat-list message).
  const agent = ctx.agents.get(session.id)
  if (agent !== undefined) {
    enqueueSelectionMessage(agent, summarizeSelection(selection))
  }
  ctx.emit('cicada/editor/selection', { sessionId: session.id, selection })
  bridge?.broadcast({ type: 'selection.confirm', sessionId: session.id, selection })
}

/**
 * Deterministic language summary block (P6 定案 G-P6-8 placeholder: text
 * template + the raw selection JSON; the deriver network expansion lands M3).
 * @param selection - validated selected items.
 * @returns the model-facing text block.
 */
function summarizeSelection(selection: SelectionItem[]): string {
  const names = selection.map(item => item.refdes ?? item.uuid ?? item.kind).join('、')
  return `画布选中了 ${String(selection.length)} 个图元：${names}。请依据本次选中内容继续当前原理图工作。\n\n选中数据（JSON）：\n${JSON.stringify(selection)}`
}

/**
 * Compute the schematic baseline hash: sha256 hex of the `.cicada_sch` bytes
 * (E13-D2), resolved from the session cwd (P6 定案 G-P6-7; P7 aligns with the
 * runtime FsVersion).
 * @param ctx - host context.
 * @param session - the target session carrying `header.cwd`.
 * @returns the hash, or undefined when the session has no cwd or the file is unreadable.
 */
async function readBaseline(ctx: Context, session: StateSessionRef): Promise<string | undefined> {
  const cwd = session.header.cwd
  if (cwd === undefined) return undefined
  try {
    const target = await ctx.fs.resolve(`${WORKSPACE_DIR}/${SCHEMATIC_FILE_NAME}`, { cwd })
    const text = await ctx.fs.readText(target)
    return createHash('sha256').update(text, 'utf8').digest('hex')
  } catch {
    return undefined
  }
}
