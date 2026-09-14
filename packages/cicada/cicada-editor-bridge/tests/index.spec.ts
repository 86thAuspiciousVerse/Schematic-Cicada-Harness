import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'

import { apply, inject, publishRuntimeChange } from '../src/index.ts'
import { SELECTION_PATH, SYNC_PATH, type SelectionItem } from '../src/contract.ts'

const TOKEN_LINE = /^cicada-editor:\s+(\d+)\s+([A-Za-z0-9_-]+)$/

describe('editor bridge plugin over a real composition', () => {
  it('maps a committed runtime change to changelog, baseline, and refresh frames', () => {
    const frames: unknown[] = []
    publishRuntimeChange({ broadcast: frame => frames.push(frame), dispose: () => {} }, {
      workspace: 'ws', file: 'schematic.cicada_sch', origin: 'watcher', baselineVersion: 'v2', baselineHash: 'a'.repeat(64),
      entries: [{ seq: 4, type: 'user_edit', tool: 'watcher', summary: '新增 R1', at: 1 }],
    })
    expect(frames).toEqual([
      { type: 'changelog', seq: 4, kind: 'user_edit', summary: '新增 R1', baselineHash: 'a'.repeat(64) },
      { type: 'baseline', file: 'schematic.cicada_sch', baselineHash: 'a'.repeat(64) },
      { type: 'canvas.refresh', file: 'schematic.cicada_sch', reason: 'watcher' },
    ])
  })

  let ctx: Context | undefined
  let port = 0

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
  })

  /** Capture the announced editor line and return its token (and the captured lines). */
  async function setup(): Promise<{
    followup: ReturnType<typeof vi.fn>
    selections: unknown[]
    token: string
    lines: string[]
  }> {
    ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const followup = vi.fn()
    const inbox = { prepend: vi.fn(), append: vi.fn() }
    const agent = {
      session: { id: SessionId('session-main'), header: { cwd: '/workspace' } },
      followup,
      inbox,
    }
    ctx.provide('agents', {
      get: (id: string) => (String(id) === 'session-main' ? agent : undefined),
      roots: () => [agent],
    } as never)
    ctx.provide('fs', {
      resolve: async () => ({ targetKey: 'k', displayPath: '.cicada/schematic.cicada_sch' }),
      readText: async () => '(schematic …)',
    } as never)
    const selections: unknown[] = []
    ctx.on('cicada/editor/selection', payload => { selections.push(payload) })

    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try {
      await ctx.plugin({ name: 'cicada-editor-bridge', inject, apply }, {})
    } finally {
      console.log = original
    }
    port = ctx.webServer.port
    const announced = lines.map(line => TOKEN_LINE.exec(line)).find(match => match !== null)
    if (announced === undefined) throw new Error('editor line was not announced')
    return { followup, selections, token: announced[2]!, lines }
  }

  function agentInboxPrepend(): ReturnType<typeof vi.fn> {
    const provided = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('agents')
    const ag = (provided as { get?: (id: string) => unknown } | undefined)?.get?.('session-main')
    const inbox = (ag as { inbox?: { prepend: ReturnType<typeof vi.fn> } } | undefined)?.inbox
    return (inbox?.prepend ?? vi.fn()) as ReturnType<typeof vi.fn>
  }

  function post(token: string, body: unknown) {
    return fetch(`http://127.0.0.1:${String(port)}${SELECTION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  }

  it('announces the editor line exactly once on boot', async () => {
    const { lines, token } = await setup()
    expect(lines.filter(line => TOKEN_LINE.test(line))).toHaveLength(1)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('injects a selection as plugin-source next-step context (inbox) and emits the remote event', async () => {
    const { followup, selections, token } = await setup()
    const selection: SelectionItem[] = [{ kind: 'symbol', refdes: 'R1', net: ['NET1'] }]
    const res = await post(token, { selection })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, sessionId: 'session-main', injected: true })

    // DSH 队列投影：plugin 源 next-step 消息 = placement 'context'（系统上下文），
    // 不进对话列表；实现层面不再走 followup。
    expect(followup).not.toHaveBeenCalled()
    expect(agentInboxPrepend()).toHaveBeenCalledTimes(1)
    const [target, message] = agentInboxPrepend().mock.calls[0]! as [
      string, { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string } },
    ]
    expect(target).toBe('next-step')
    expect(message.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-cicada-editor-bridge' })
    expect(message.content[0]!.type).toBe('text')
    expect(message.content[0]!.text).toContain('画布选中了 1 个图元')
    expect(message.content[0]!.text).toContain(JSON.stringify(selection))
    expect(selections).toEqual([{ sessionId: 'session-main', selection }])
  })

  it('queues an attachNextTurn selection into the next-step context channel', async () => {
    const { token } = await setup()
    const selection: SelectionItem[] = [{ kind: 'wire', uuid: 'u-9' }]
    const res = await post(token, { selection, sessionId: 'session-main', attachNextTurn: true })
    expect(res.status).toBe(200)
    const [target] = agentInboxPrepend().mock.calls[0]! as [string]
    expect(target).toBe('next-step')
  })

  it('pushes a selection.confirm frame on the ws after injection', async () => {
    const { token } = await setup()
    // Buffer from construction: the hello may be emitted before `open`
    // resolves (loopback race), so a post-open `once` would lose it.
    const frames: string[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/cicada/editor/ws`, {
      headers: { authorization: `Bearer ${token}` },
    })
    socket.on('message', data => { frames.push(String(data)) })
    try {
      await once(socket, 'open')
      const selection: SelectionItem[] = [{ kind: 'wire', uuid: 'u-9' }]
      const res = await post(token, { selection })
      expect(res.status).toBe(200)
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2))
      const frame = JSON.parse(frames[1]!) as { type: string; sessionId: string; selection: SelectionItem[] }
      expect(frame).toEqual({ type: 'selection.confirm', sessionId: 'session-main', selection })
    } finally {
      socket.close()
    }
  })

  it('broadcasts lock frames on every mode change and reports the mode in /state', async () => {
    const { token } = await setup()
    const lock = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('cicadaEditorLock') as
      | { acquireAgent(): unknown; releaseAgent(): unknown }
      | undefined
    expect(lock).toBeDefined()
    const frames: string[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/cicada/editor/ws`, {
      headers: { authorization: `Bearer ${token}` },
    })
    socket.on('message', data => { frames.push(String(data)) })
    try {
      await once(socket, 'open')
      lock!.acquireAgent()
      await vi.waitFor(() => expect(frames.some(f => f.includes('agent-editing'))).toBe(true))
      const state = await (await fetch(`http://127.0.0.1:${String(port)}/cicada/editor/state?token=${token}`)).json() as { lock?: string }
      expect(state.lock).toBe('agent-editing')
      lock!.releaseAgent()
      await vi.waitFor(() => expect(frames.at(-1)).toContain('"idle"'))
      // The human lease is refused while the agent holds it (409) and works when idle.
      lock!.acquireAgent()
      const refused = await fetch(`http://127.0.0.1:${String(port)}/cicada/editor/canvas/enter-edit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(refused.status).toBe(409)
      lock!.releaseAgent()
      const taken = await fetch(`http://127.0.0.1:${String(port)}/cicada/editor/canvas/enter-edit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(taken.status).toBe(200)
      await expect(taken.json()).resolves.toEqual({ ok: true, mode: 'human-editing' })
      const released = await fetch(`http://127.0.0.1:${String(port)}/cicada/editor/canvas/leave-edit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      await expect(released.json()).resolves.toEqual({ ok: true, mode: 'idle' })
    } finally {
      socket.close()
    }
  })

  it('reports the baseline hash through the state snapshot', async () => {
    const { token } = await setup()
    const res = await fetch(`http://127.0.0.1:${String(port)}/cicada/editor/state?token=${token}`)
    expect(res.status).toBe(200)
    const state = await res.json() as { file: string; baselineHash: string; sessionId: string }
    expect(state.file).toBe('schematic.cicada_sch')
    expect(state.baselineHash).toMatch(/^[0-9a-f]{64}$/)
    expect(state.sessionId).toBe('session-main')
  })

  it('syncs the engine document to the session workspace, verified against /scene', async () => {
    const realFetch = globalThis.fetch
    const engineCalls: string[] = []
    process.env.CICADA_ENGINE_URL = 'http://127.0.0.1:65530'
    process.env.CICADA_ENGINE_TOKEN = 'engine-token'
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('http://127.0.0.1:65530')) return await realFetch(input as never, init)
      engineCalls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/scene')) return new Response(JSON.stringify({ file: '' }), { status: 200 })
      if (url.endsWith('/document')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    try {
      const { token } = await setup()
      const res = await fetch(`http://127.0.0.1:${String(port)}${SYNC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId: 'session-main' }),
      })
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({
        ok: true,
        sessionId: 'session-main',
        file: '/workspace/.cicada/schematic.cicada_sch',
        cwd: '/workspace',
      })
      // Verified sync: read the engine's current document first, then push only
      // when it differs (a pure path cache cannot heal a restarted engine).
      expect(engineCalls).toEqual([
        'GET http://127.0.0.1:65530/scene',
        'POST http://127.0.0.1:65530/document',
      ])
    } finally {
      delete process.env.CICADA_ENGINE_URL
      delete process.env.CICADA_ENGINE_TOKEN
      vi.unstubAllGlobals()
    }
  })
})
