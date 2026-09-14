/**
 * Canvas driver regression: the pane must point the engine at ITS session's
 * workspace before the first read, and self-heal when an /ops is refused for a
 * missing document. 2026-09-08 defect: opening a session without sending a
 * message left the engine on an empty document — the canvas stayed blank and
 * every human edit failed at saveback ("unable to open schematic file for
 * writing"), because only a user turn used to sync the engine.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasDriver } from '../src/client/canvas_driver.ts'

const ENGINE_PORT = 40904
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`
const DOC = 'C:/dsh/cicada2/.cicada/schematic.cicada_sch'

const EMPTY_SCENE = {
  file: DOC,
  hash: 'hash-1',
  version: '20260803',
  components: [],
  wires: [],
  junctions: [],
  labels: [],
  no_connects: [],
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  close(): void {}
  /** Test hook: deliver one downlink frame. */
  emit(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }) }
  /** Test hook: simulate a dropped socket. */
  drop(): void { this.onclose?.() }
}

interface Call { method: string; url: string; body: unknown }

function makeActions() {
  const statuses: string[] = []
  return {
    statuses,
    actions: {
      setReady: () => {},
      setEngine: () => {},
      setScene: () => {},
      setViewport: () => {},
      zoom: () => {},
      panBy: () => {},
      setSelection: () => {},
      clearSelection: () => {},
      setLock: () => {},
      setLibList: () => {},
      setStatus: (status: string) => { statuses.push(status) },
      setMarquee: () => {},
      setWireDraft: () => {},
      setMoveGhost: () => {},
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Install a fetch stub that records calls and answers the canvas routes. */
function stubFetch(handler: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    }
    calls.push(call)
    const response = handler(call)
    if (response === undefined) throw new Error(`unexpected request ${call.method} ${call.url}`)
    return response
  })
  return calls
}

describe('createCanvasDriver', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:3123' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('syncs the engine document to its own session before reading the scene', async () => {
    const { actions } = makeActions()
    const calls = stubFetch((call) => {
      if (call.url === '/cicada/editor/state') {
        return json({ enginePort: ENGINE_PORT, engineToken: 'tk', sessionId: 'session-fallback', cwd: 'C:\\dsh\\cicada2' })
      }
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: true, file: DOC })
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [{ name: 'C', pins: 2 }] })
      if (call.url === `${ENGINE}/scene`) return json(EMPTY_SCENE)
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-f2b3c7ca')
    await driver.init()

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET /cicada/editor/state',
      'POST /cicada/editor/canvas/sync',
      `GET ${ENGINE}/lib/list`,
      `GET ${ENGINE}/scene`,
    ])
    // The canvas's OWN session wins over the /state fallback id.
    expect(calls[1]?.body).toEqual({ sessionId: 'session-f2b3c7ca' })
  })

  it('reports a failed sync and still renders whatever the engine holds', async () => {
    const { actions, statuses } = makeActions()
    stubFetch((call) => {
      if (call.url === '/cicada/editor/state') return json({ enginePort: ENGINE_PORT, engineToken: 'tk' })
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: false, reason: 'no-workspace' })
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [] })
      if (call.url === `${ENGINE}/scene`) return json({ ...EMPTY_SCENE, file: '' })
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-1')
    await driver.init()

    expect(statuses.at(-1)).toContain('未连接工作区原理图')
  })

  it('re-syncs after an /ops conflict (no document loaded / external write)', async () => {
    const { actions, statuses } = makeActions()
    const calls = stubFetch((call) => {
      if (call.url === '/cicada/editor/state') return json({ enginePort: ENGINE_PORT, engineToken: 'tk' })
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: true, file: DOC })
      if (call.url === '/cicada/editor/canvas/enter-edit') return json({ ok: true, mode: 'human-editing' })
      if (call.url === '/cicada/editor/canvas/leave-edit') return json({ ok: true, mode: 'idle' })
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [] })
      if (call.url === `${ENGINE}/scene`) return json(EMPTY_SCENE)
      if (call.url === `${ENGINE}/ops`) {
        return json({ error: { code: 'conflict', message: 'no document loaded' } }, 409)
      }
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-1')
    await driver.init()
    calls.length = 0

    const ok = await driver.drawWire([[0, 0], [12700, 0]])

    expect(ok).toBe(false)
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'POST /cicada/editor/canvas/enter-edit',
      `POST ${ENGINE}/ops`,
      'POST /cicada/editor/canvas/sync',
      `GET ${ENGINE}/scene`,
    ])
    expect(statuses.at(-1)).toContain('重新同步')
  })

  it('refuses a gesture while an agent turn holds the lock (no engine call)', async () => {
    const { actions, statuses } = makeActions()
    const calls = stubFetch((call) => {
      if (call.url === '/cicada/editor/state') {
        return json({ enginePort: ENGINE_PORT, engineToken: 'tk', lock: 'agent-editing' })
      }
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: true, file: DOC })
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [] })
      if (call.url === `${ENGINE}/scene`) return json(EMPTY_SCENE)
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-1')
    await driver.init()
    calls.length = 0

    const ok = await driver.drawWire([[0, 0], [12700, 0]])

    expect(ok).toBe(false)
    expect(calls).toEqual([])
    expect(statuses.at(-1)).toContain('画布只读')
  })

  it('refuses the gesture when the bridge rejects the human lease (409)', async () => {
    const { actions, statuses } = makeActions()
    const calls = stubFetch((call) => {
      if (call.url === '/cicada/editor/state') return json({ enginePort: ENGINE_PORT, engineToken: 'tk' })
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: true, file: DOC })
      if (call.url === '/cicada/editor/canvas/enter-edit') {
        return json({ ok: false, mode: 'agent-editing' }, 409)
      }
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [] })
      if (call.url === `${ENGINE}/scene`) return json(EMPTY_SCENE)
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-1')
    await driver.init()
    calls.length = 0

    const ok = await driver.drawWire([[0, 0], [12700, 0]])

    expect(ok).toBe(false)
    expect(calls.map(call => call.url)).toEqual(['/cicada/editor/canvas/enter-edit'])
    expect(statuses.at(-1)).toContain('画布只读')
  })

  it('self-heals a stale agent lock: the watchdog re-reads /state and re-enables gestures', async () => {
    vi.useFakeTimers()
    const { actions } = makeActions()
    let stateLock: 'idle' | 'agent-editing' = 'agent-editing'
    const calls = stubFetch((call) => {
      if (call.url === '/cicada/editor/state') {
        return json({ enginePort: ENGINE_PORT, engineToken: 'tk', lock: stateLock })
      }
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: true, file: DOC })
      if (call.url === '/cicada/editor/canvas/enter-edit') return json({ ok: true, mode: 'human-editing' })
      if (call.url === '/cicada/editor/canvas/leave-edit') return json({ ok: true, mode: 'idle' })
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [] })
      if (call.url === `${ENGINE}/scene`) return json(EMPTY_SCENE)
      if (call.url === `${ENGINE}/ops`) return json({ ok: true, scene: EMPTY_SCENE })
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-1')
    await driver.init()
    expect(calls.filter(call => call.url === `${ENGINE}/ops`)).toHaveLength(0)

    // Locked by the agent: the gesture is refused without touching the engine.
    expect(await driver.drawWire([[0, 0], [12700, 0]])).toBe(false)
    expect(calls.filter(call => call.url === `${ENGINE}/ops`)).toHaveLength(0)

    // The host released the lock but the frame was lost; the watchdog recovers.
    stateLock = 'idle'
    await vi.advanceTimersByTimeAsync(3_500)
    calls.length = 0
    expect(await driver.drawWire([[0, 0], [12700, 0]])).toBe(true)
    expect(calls.map(call => call.url)).toEqual([
      '/cicada/editor/canvas/enter-edit',
      `${ENGINE}/ops`,
      `${ENGINE}/scene`,
    ])
  })

  it('reconnects the downlink and re-reads lock + scene after a dropped socket', async () => {
    vi.useFakeTimers()
    const { actions } = makeActions()
    const calls = stubFetch((call) => {
      if (call.url === '/cicada/editor/state') return json({ enginePort: ENGINE_PORT, engineToken: 'tk', lock: 'idle' })
      if (call.url === '/cicada/editor/canvas/sync') return json({ ok: true, file: DOC })
      if (call.url === `${ENGINE}/lib/list`) return json({ symbols: [] })
      if (call.url === `${ENGINE}/scene`) return json(EMPTY_SCENE)
      return undefined
    })
    const driver = createCanvasDriver(actions as never, 'session-1')
    await driver.init()
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.instances[0]!.drop()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(calls.filter(call => call.url === `${ENGINE}/scene`).length).toBeGreaterThanOrEqual(2)
  })
})
