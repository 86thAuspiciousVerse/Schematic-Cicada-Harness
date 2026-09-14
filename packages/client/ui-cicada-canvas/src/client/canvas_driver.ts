/**
 * Canvas driver (M1c): the pane's single data channel — engine HTTP (state/
 * scene/hit/ops/lib) plus the /cicada/editor/ws downlink (lock + canvas.refresh
 * frames). Non-React object created inside the register's inject factory; it
 * publishes through store actions (the component touches the store only).
 * Browser same-origin is trusted by the bridge (routes.ts/ws.ts M1c 放行).
 */
import type { CanvasActions, CanvasLibItem, CanvasScene, CanvasSel } from './canvas_store.ts'

const STATE_PATH = '/cicada/editor/state'
const SYNC_PATH = '/cicada/editor/canvas/sync'
const ENTER_EDIT = '/cicada/editor/canvas/enter-edit'
const LEAVE_EDIT = '/cicada/editor/canvas/leave-edit'
const WS_PATH = '/cicada/editor/ws'
const ENGINE_SCENE = '/scene'
const ENGINE_OPS = '/ops'
const ENGINE_HIT = '/hit'
const ENGINE_LIB_LIST = '/lib/list'
const ENGINE_WIRE_PREVIEW = '/wire/preview'

/** Human canvas lease idle window; the bridge enforces the same 5s (docs/05 §1). */
const EDIT_LEASE_MS = 5_000
/** Lock reconciliation cadence while the agent holds the lock (missed-frame self-heal). */
const LOCK_WATCH_MS = 3_000
/** Downlink reconnect delay after a dropped WS. */
const WS_RETRY_MS = 1_500

type LockMode = 'idle' | 'agent-editing' | 'human-editing'

/** A canvas selection build by the component from its store state. */
export interface CanvasSelectionItem {
  kind: 'component' | 'pin' | 'wire' | 'junction' | 'label'
  refdes?: string
  value?: string
  pins?: string[]
  net?: string[]
}

export interface CanvasApi {
  /** One-shot init: /state → engine url/token → scene + lib + ws subscribe. */
  init(): Promise<void>
  refresh(): Promise<void>
  /** Re-fit the viewport to the whole scene (toolbar 适应视图). */
  fit(): void
  /** Engine /hit without side effects (drag start decides move vs marquee).
   * `tolIU` is the pick tolerance in engine IU (px-based, zoom independent). */
  hitAt(x: number, y: number, tolIU?: number): Promise<{ kind?: string; refdes?: string; uuid?: string } | undefined>
  hitAndSelect(x: number, y: number, tolIU?: number): Promise<void>   // engine IU
  place(libId: string, x: number, y: number): Promise<void>   // engine IU; auto-selects the placed symbol
  /** Commit a wire (engine IU points); resolves false on engine error. */
  /** Engine-side wire preview: snap + 45° break point + terminal flag. */
  wirePreview(
    anchor: [number, number],
    cursor: [number, number],
    prevDir: [number, number] | null,
    posture: boolean,
    snapRadIU: number,
  ): Promise<{ mid: [number, number]; end: [number, number]; terminal: boolean } | undefined>
  drawWire(points: [number, number][]): Promise<boolean>
  /** Commit a move (IU delta); resolves false on engine error. */
  moveBy(refdeses: string[], dx: number, dy: number): Promise<boolean>
  removeSelection(selection: CanvasSel[]): Promise<void>
  undo(): Promise<void>
  /** 加入到上下文: queue selection for the current session's next user turn. */
  addToContext(items: CanvasSelectionItem[]): Promise<string>
}

interface EngineResp { ok?: boolean; error?: { code?: string; message?: string } }

interface OpResult { ok: boolean; error?: string; conflict?: boolean; locked?: boolean }

export function createCanvasDriver(actions: CanvasActions, currentSessionId: string): CanvasApi {
  let ws: WebSocket | undefined
  let scene: CanvasScene | null = null
  let engineUrl = ''
  let engineToken = ''
  /** 当前选中会话（注入目标）；/state 的 sessionId 仅作缺失时回退。 */
  let sessionId = currentSessionId
  /** Editor lock mode (docs/05 §1): `agent-editing` = AI 回合进行中，画布只读。 */
  let lockMode: LockMode = 'idle'
  let leaseTimer: ReturnType<typeof setTimeout> | undefined
  /** Missed-frame watchdog (only armed while the agent holds the lock). */
  let lockWatch: ReturnType<typeof setInterval> | undefined
  let wsRetry: ReturnType<typeof setTimeout> | undefined

  async function callEngine<T>(path: string, body?: unknown): Promise<T | undefined> {
    if (engineUrl === '') return undefined
    const res = await fetch(`${engineUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Cicada-Token': engineToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    // Parse the body even on non-2xx: the engine's error payload carries the
    // conflict/refusal code the gesture layer must react to (409 = resync).
    const text = await res.text()
    if (text === '') return undefined
    try {
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }

  async function loadScene(): Promise<void> {
    const snap = await callEngine<CanvasScene>(ENGINE_SCENE)
    if (snap === undefined || !Array.isArray(snap.components)) return
    scene = snap
    actions.setScene(snap)
  }

  /**
   * Ask the host to point the engine at THIS session's workspace schematic
   * (verified host-side sync, docs/05 §2). The canvas must not wait for a user
   * turn: opening a session and drawing immediately is a normal flow, and an
   * unsynced engine silently edits a phantom document (2026-09-08 缺陷).
   * @returns true when the engine serves this session's file afterwards.
   */
  async function syncDocument(): Promise<boolean> {
    try {
      const res = await fetch(SYNC_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionId === '' ? {} : { sessionId }),
      })
      if (!res.ok) return false
      const body = (await res.json()) as { ok?: boolean }
      return body.ok === true
    } catch {
      return false
    }
  }

  /**
   * Take/refresh the human canvas lease before a gesture (docs/05 §1). While an
   * agent turn holds the lock the bridge answers 409 and the canvas stays
   * read-only — the AI's plan must not be disturbed by a mid-turn edit.
   * @returns true when the gesture may proceed.
   */
  async function beginHumanEdit(): Promise<boolean> {
    try {
      const res = await fetch(ENTER_EDIT, { method: 'POST' })
      const body = (await res.json().catch(() => undefined)) as { ok?: boolean; mode?: LockMode } | undefined
      const mode = body?.mode ?? (res.ok ? 'human-editing' : 'agent-editing')
      lockMode = mode
      actions.setLock(mode)
      if (res.ok && body?.ok === true) {
        scheduleLeaseRelease()
        return true
      }
      actions.setStatus('AI 正在修改原理图，画布只读')
      return false
    } catch {
      // Host unreachable: do not wedge the canvas on a transport failure.
      return true
    }
  }

  /** Drop the human lease 5s after the last gesture (bridge enforces the same). */
  function scheduleLeaseRelease(): void {
    if (leaseTimer !== undefined) clearTimeout(leaseTimer)
    leaseTimer = setTimeout(() => {
      leaseTimer = undefined
      void fetch(LEAVE_EDIT, { method: 'POST' }).catch(() => undefined)
    }, EDIT_LEASE_MS)
  }

  /**
   * Post an /ops mutation. A 409 conflict means the disk content moved under us
   * (AI write): re-sync /scene so the snapshot is current again and report the
   * conflict so the gesture layer can drop its optimistic preview.
   */
  async function callOp(body: unknown): Promise<OpResult> {
    if (lockMode === 'agent-editing') {
      actions.setStatus('AI 正在修改原理图，画布只读')
      return { ok: false, error: 'editor locked by the agent', locked: true }
    }
    if (!await beginHumanEdit()) return { ok: false, error: 'editor busy', locked: true }
    const res = await callEngine<EngineResp & { scene?: CanvasScene }>(ENGINE_OPS, body)
    scheduleLeaseRelease()
    if (res?.ok === true) return { ok: true }
    if (res?.error !== undefined) {
      if (res.error.code === 'conflict') {
        // Either an external/AI write moved the file, or the engine has no
        // document yet: re-sync the engine to this session, then re-read.
        const synced = await syncDocument()
        await loadScene()
        actions.setStatus(synced ? '检测到外部/AI 变更，正在重新同步…' : '未连接工作区原理图（引擎未同步）')
      }
      return { ok: false, error: res.error.message ?? '', conflict: res.error.code === 'conflict' }
    }
    return { ok: false, error: 'engine not connected' }
  }

  /** Initial fit-to-content: scene bbox (+margin) → viewport centered at ~0.14px/IU. */
  function fitView(snap: CanvasScene | null): void {
    if (snap === null || snap.components.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const c of snap.components) {
      const hw = c.body.rect.w / 2
      const hh = c.body.rect.h / 2
      minX = Math.min(minX, c.x - hw); maxX = Math.max(maxX, c.x + hw)
      minY = Math.min(minY, c.y - hh); maxY = Math.max(maxY, c.y + hh)
    }
    for (const w of snap.wires) for (const [px, py] of w.points) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px)
      minY = Math.min(minY, py); maxY = Math.max(maxY, py)
    }
    if (!Number.isFinite(minX)) return
    const m = 10000 // 1mm IU margin
    minX -= m; minY -= m; maxX += m; maxY += m
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const scale = Math.min(740 / spanX, 520 / spanY)
    actions.setViewport({
      scale,
      ox: 370 - ((minX + maxX) / 2) * scale,
      oy: 260 - ((minY + maxY) / 2) * scale,
    })
  }

  /**
   * Read the host's authoritative lock mode. The canvas keeps a local copy for
   * gesture gating, but that copy can go stale if a `lock` frame is lost (WS
   * drop, page suspended) — and a stale `agent-editing` blocks the very gesture
   * that would correct it, so it must be reconcilable out of band.
   */
  async function fetchLockMode(): Promise<LockMode | undefined> {
    try {
      const st = await fetch(STATE_PATH).then((r) => (r.ok ? r.json() : undefined)) as { lock?: LockMode } | undefined
      return st?.lock
    } catch {
      return undefined
    }
  }

  /** Adopt a lock mode (from a frame or a reconciliation read) and manage the watchdog. */
  function applyLockMode(mode: LockMode): void {
    lockMode = mode
    actions.setLock(mode)
    if (mode === 'agent-editing') startLockWatch()
    else stopLockWatch()
  }

  /** While the agent holds the lock, re-check the host every 3s: a missed
   * `lock=idle` frame must not leave the canvas permanently read-only. */
  function startLockWatch(): void {
    if (lockWatch !== undefined) return
    lockWatch = setInterval(() => {
      void (async () => {
        const mode = await fetchLockMode()
        if (mode !== undefined && mode !== lockMode) applyLockMode(mode)
        if (mode === 'idle') await loadScene()
      })()
    }, LOCK_WATCH_MS)
  }

  function stopLockWatch(): void {
    if (lockWatch === undefined) return
    clearInterval(lockWatch)
    lockWatch = undefined
  }

  /** Subscribe to the downlink; reconnects on close (a dead socket would
   * silently freeze both the lock overlay and AI-write refreshes). */
  function connectWs(): void {
    const socket = new WebSocket(`${location.origin}${WS_PATH}`)
    ws = socket
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as
          | { type: 'lock'; mode: LockMode }
          | { type: 'canvas.refresh'; reason?: string }
        if (frame.type === 'lock') {
          applyLockMode(frame.mode)
        } else if (frame.type === 'canvas.refresh' && frame.reason === 'ai-write') void loadScene()
      } catch {
        // 未知/畸形帧忽略（下行帧是消费方白名单）
      }
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = undefined
      if (wsRetry !== undefined) clearTimeout(wsRetry)
      wsRetry = setTimeout(() => {
        wsRetry = undefined
        if (ws === undefined) {
          connectWs()
          // Frames missed while offline: re-read the lock and the scene.
          void (async () => {
            const mode = await fetchLockMode()
            if (mode !== undefined) applyLockMode(mode)
            await loadScene()
          })()
        }
      }, WS_RETRY_MS)
    }
  }

  return {    async init() {
      try {
        const st = await fetch(STATE_PATH).then((r) => (r.ok ? r.json() : undefined)) as
          | { enginePort?: number; engineToken?: string; sessionId?: string; lock?: LockMode }
          | undefined
        if (sessionId === '') sessionId = st?.sessionId ?? '' // 回退路径''
        if (st?.enginePort !== undefined && st?.engineToken !== undefined) {
          engineUrl = `http://127.0.0.1:${st.enginePort}`
          engineToken = st.engineToken
          actions.setEngine(engineUrl, engineToken)
        }
        // Lock state as of page load: an agent turn may already be running, in
        // which case the canvas opens read-only until the `lock=idle` frame.
        if (st?.lock !== undefined) applyLockMode(st.lock)
        // The engine must serve THIS session's workspace before the first read;
        // otherwise the canvas shows an empty/stale document and human edits
        // fail at saveback (no truth file behind the engine).
        const synced = await syncDocument()
        const lib = await callEngine<{ symbols?: { name?: string; pins?: number }[] }>(ENGINE_LIB_LIST)
        const items: CanvasLibItem[] = (lib?.symbols ?? []).map((s) => ({
          name: s.name ?? '',
          pins: s.pins ?? 0,
        }))
        actions.setLibList(items)
        await loadScene()
        if (!synced) actions.setStatus('未连接工作区原理图（引擎未同步，可重新打开会话）')
        fitView(scene)
        actions.setReady(true)
        connectWs()
      } catch (error) {
        actions.setStatus(`canvas init failed: ${String(error)}`)
      }
    },
    async refresh() {
      await loadScene()
    },
    fit() {
      fitView(scene)
    },
    async hitAt(x, y, tolIU = 8000) {
      return await callEngine<{ kind?: string; refdes?: string; uuid?: string }>(ENGINE_HIT, {
        x,
        y,
        tolMils: tolIU,
      })
    },
    async hitAndSelect(x, y, tolIU = 8000) {
      const hit = await callEngine<{ kind?: string; refdes?: string; uuid?: string }>(ENGINE_HIT, {
        x,
        y,
        tolMils: tolIU,
      })
      if (hit?.kind === 'component' && hit.refdes !== undefined) {
        actions.setSelection([{ kind: 'component', refdes: hit.refdes }])
      } else if (hit?.kind === 'wire' && hit.uuid !== undefined) {
        actions.setSelection([{ kind: 'wire', uuid: hit.uuid }])
      } else {
        actions.clearSelection()
      }
    },
    async place(libId, x, y) {
      // 放置后自动选中：diff 旧 /scene 的 refdes 集合，新出现的即本次放置的符号。
      const before = new Set((scene?.components ?? []).map((c) => c.refdes))
      const res = await callOp({
        fileHash: scene?.hash ?? '',
        op: 'place-symbol',
        libId,
        x,
        y,
        rotation: 0,
      })
      if (res.ok) {
        await loadScene()
        const added = (scene?.components ?? [])
          .filter((c) => !before.has(c.refdes))
          .map((c) => ({ kind: 'component' as const, refdes: c.refdes }))
        actions.setSelection(added)
        if (added.length > 0) actions.setStatus(`placed ${added.map((x) => x.refdes).join(', ')}`)
      } else {
        if (res.conflict !== true && res.locked !== true) actions.setStatus(`place failed: ${res.error ?? ''}`)
      }
    },
    async wirePreview(anchor, cursor, prevDir, posture, snapRadIU) {
      return await callEngine<{ mid?: number[]; end?: number[]; terminal?: boolean }>(ENGINE_WIRE_PREVIEW, {
        anchor,
        cursor,
        ...(prevDir === null ? {} : { prevDir }),
        posture,
        snapRad: snapRadIU,
      }) as { mid: [number, number]; end: [number, number]; terminal: boolean } | undefined
    },
    async drawWire(points) {
      if (points.length < 2) return true
      const res = await callOp({ fileHash: scene?.hash ?? '', op: 'draw-wire', points })
      if (res.ok) {
        await loadScene()
        return true
      }
      if (res.conflict !== true && res.locked !== true) actions.setStatus(`wire failed: ${res.error ?? ''}`)
      return false
    },
    async moveBy(refdeses, dx, dy) {
      if (refdeses.length === 0 || (dx === 0 && dy === 0)) return true
      const res = await callOp({ fileHash: scene?.hash ?? '', op: 'move', refdeses, dx, dy })
      if (res.ok) {
        await loadScene()
        actions.setStatus(`moved ${refdeses.join(', ')}`)
        return true
      }
      if (res.conflict !== true && res.locked !== true) actions.setStatus(`move failed: ${res.error ?? ''}`)
      return false
    },
    async removeSelection(selection) {
      const refdeses = selection
        .filter((sel): sel is { kind: 'component'; refdes: string } => sel.kind === 'component')
        .map((sel) => sel.refdes)
      const wires = selection
        .filter((sel): sel is { kind: 'wire'; uuid: string } => sel.kind === 'wire')
        .map((sel) => sel.uuid)
      if (refdeses.length === 0 && wires.length === 0) return
      const res = await callOp({ fileHash: scene?.hash ?? '', op: 'delete', refdeses, wires })
      if (res.ok) {
        actions.clearSelection()
        await loadScene()
      } else {
        if (res.conflict !== true && res.locked !== true) actions.setStatus(`delete failed: ${res.error ?? ''}`)
      }
    },
    async undo() {
      const res = await callOp({ fileHash: scene?.hash ?? '', op: 'undo' })
      if (res.ok) await loadScene()
    },
    async addToContext(items) {
      // 契约词表（cicada-editor-bridge contract.ts）是 symbol/wire/label/no_connect；
      // 画布内部词表是 component/pin/... —— 发送点归一，避免 400。
      const mapped = items
        .filter((it) => it.kind !== 'pin' && it.kind !== 'junction')
        .map((it) => (
          it.kind === 'component'
            ? { ...it, kind: 'symbol' as const }
            : it
        ))
      if (mapped.length === 0) return '无可加入的图元（暂不支持该类型）'
      const res = await fetch('/cicada/editor/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection: mapped, sessionId, attachNextTurn: true }),
      })
      return res.ok ? `已加入上下文（${mapped.length} 项，随下一条消息送达）` : '加入上下文失败'
    },
  }
}

export interface CanvasDriverHandle { client: CanvasApi }
