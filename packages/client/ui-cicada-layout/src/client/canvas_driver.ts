/**
 * Canvas driver (M1c): the pane's single data channel — engine HTTP (state/
 * scene/hit/ops/lib) plus the /cicada/editor/ws downlink (lock + canvas.refresh
 * frames). Non-React object created inside the register's inject factory; it
 * publishes through store actions (the component touches the store only).
 * Browser same-origin is trusted by the bridge (routes.ts/ws.ts M1c 放行).
 */
import type { CanvasActions, CanvasLibItem, CanvasScene } from './canvas_store.ts'

const STATE_PATH = '/cicada/editor/state'
const WS_PATH = '/cicada/editor/ws'
const ENGINE_SCENE = '/scene'
const ENGINE_OPS = '/ops'
const ENGINE_HIT = '/hit'
const ENGINE_LIB_LIST = '/lib/list'

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
  hitAndSelect(x: number, y: number): Promise<void>          // engine IU
  place(libId: string, x: number, y: number): Promise<void>   // engine IU
  removeSelection(refdeses: string[]): Promise<void>
  undo(): Promise<void>
  /** 加入到上下文: queue selection for the current session's next user turn. */
  addToContext(items: CanvasSelectionItem[]): Promise<string>
}

interface EngineResp { ok?: boolean; error?: { code?: string; message?: string } }

export function createCanvasDriver(actions: CanvasActions): CanvasApi {
  let ws: WebSocket | undefined
  let scene: CanvasScene | null = null
  let engineUrl = ''
  let engineToken = ''
  let sessionId = ''

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
    if (!res.ok) return undefined
    const text = await res.text()
    return text === '' ? undefined : (JSON.parse(text) as T)
  }

  async function loadScene(): Promise<void> {
    const snap = await callEngine<CanvasScene>(ENGINE_SCENE)
    if (snap === undefined) return
    scene = snap
    actions.setScene(snap)
  }

  return {
    async init() {
      try {
        const st = await fetch(STATE_PATH).then((r) => (r.ok ? r.json() : undefined)) as
          | { enginePort?: number; engineToken?: string; sessionId?: string }
          | undefined
        sessionId = st?.sessionId ?? ''
        if (st?.enginePort !== undefined && st?.engineToken !== undefined) {
          engineUrl = `http://127.0.0.1:${st.enginePort}`
          engineToken = st.engineToken
          actions.setEngine(engineUrl, engineToken)
        }
        const lib = await callEngine<{ symbols?: { name?: string; pins?: number }[] }>(ENGINE_LIB_LIST)
        const items: CanvasLibItem[] = (lib?.symbols ?? []).map((s) => ({
          name: s.name ?? '',
          pins: s.pins ?? 0,
        }))
        actions.setLibList(items)
        await loadScene()
        if (scene !== null && scene.components[0] !== undefined) {
          const c = scene.components[0]
          actions.setViewport({ scale: 0.05, ox: -c.x * 0.05 + 80, oy: -c.y * 0.05 + 80 })
        }
        actions.setReady(true)
        const socket = new WebSocket(`${location.origin}${WS_PATH}`)
        ws = socket
        socket.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as
              | { type: 'lock'; mode: 'idle' | 'agent-editing' | 'human-editing' }
              | { type: 'canvas.refresh'; reason?: string }
            if (frame.type === 'lock') actions.setLock(frame.mode)
            else if (frame.type === 'canvas.refresh' && frame.reason === 'ai-write') void loadScene()
          } catch {
            // 未知/畸形帧忽略（下行帧是消费方白名单）
          }
        }
      } catch (error) {
        actions.setStatus(`canvas init failed: ${String(error)}`)
      }
    },
    async refresh() {
      await loadScene()
    },
    async hitAndSelect(x, y) {
      const hit = await callEngine<{ kind?: string; refdes?: string }>(ENGINE_HIT, {
        x,
        y,
        tolMils: 5000,
      })
      if (hit?.kind === 'component' && hit.refdes !== undefined) actions.setSelection([hit.refdes])
      else actions.clearSelection()
    },
    async place(libId, x, y) {
      const res = await callEngine<EngineResp>(ENGINE_OPS, {
        fileHash: scene?.hash ?? '',
        op: 'place-symbol',
        libId,
        x,
        y,
        rotation: 0,
      })
      if (res?.ok === true) await loadScene()
      else actions.setStatus(`place failed: ${res?.error?.message ?? ''}`)
    },
    async removeSelection(refdeses) {
      if (refdeses.length === 0) return
      const res = await callEngine<EngineResp>(ENGINE_OPS, {
        fileHash: scene?.hash ?? '',
        op: 'delete',
        refdeses,
      })
      if (res?.ok === true) {
        actions.clearSelection()
        await loadScene()
      }
    },
    async undo() {
      const res = await callEngine<EngineResp>(ENGINE_OPS, { fileHash: scene?.hash ?? '', op: 'undo' })
      if (res?.ok === true) await loadScene()
    },
    async addToContext(items) {
      const res = await fetch('/cicada/editor/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection: items, sessionId, attachNextTurn: true }),
      })
      return res.ok ? `已加入上下文（${items.length} 项，随下一条消息送达）` : '加入上下文失败'
    },
  }
}

export interface CanvasDriverHandle { client: CanvasApi }
