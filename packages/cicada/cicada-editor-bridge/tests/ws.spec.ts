import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { once } from 'node:events'

import { createWsBridge, exactKeys, isRecord, parseFrame, WS_HEARTBEAT_MS, type WsBridge } from '../src/ws.ts'
import { WS_PATH, type EditorDownlink } from '../src/contract.ts'

const TOKEN = 'tok_ABC-xyz_123'

describe('frame helpers', () => {
  it('isRecord rejects arrays, null, and scalars', () => {
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('exactKeys accepts exactly the declared keys', () => {
    expect(exactKeys({ type: 'ping', t: 1 }, ['type', 't'])).toBe(true)
    expect(exactKeys({ type: 'ping' }, ['type', 't'])).toBe(false)
    expect(exactKeys({ type: 'ping', t: 1, extra: 2 }, ['type', 't'])).toBe(false)
  })

  it('parseFrame decodes JSON records and rejects non-JSON / non-object', () => {
    expect(parseFrame('{"type":"ping","t":1}')).toEqual({ type: 'ping', t: 1 })
    expect(() => parseFrame('not json')).toThrow(/not JSON/)
    expect(() => parseFrame('[1,2]')).toThrow(/must be an object/)
  })
})

describe('ws bridge over a real webserver', () => {
  let ctx: Context | undefined
  let bridge: WsBridge | undefined
  let port = 0

  afterEach(async () => {
    bridge?.dispose()
    if (ctx !== undefined) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
  })

  async function setup(): Promise<void> {
    ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const created = createWsBridge({
      trustedHosts: [],
      matchesToken: presented => presented === TOKEN,
      port: () => ctx!.webServer.port,
    })
    bridge = created.bridge
    ctx.effect(() => ctx!.webServer.registerUpgrade(created.route))
    port = ctx.webServer.port
  }

  function url(): string {
    return `ws://127.0.0.1:${String(port)}${WS_PATH}`
  }

  /** Connect and buffer incoming frames; the hello may be emitted before `open` resolves. */
  function connect(headers: Record<string, string> = {}): Promise<{ socket: WebSocket; frames: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url(), { headers })
      const frames: string[] = []
      socket.on('message', data => { frames.push(String(data)) })
      socket.once('open', () => resolve({ socket, frames }))
      socket.once('error', reject)
    })
  }

  it('rejects the handshake without a token (401 before the 101)', async () => {
    await setup()
    await expect(connect()).rejects.toThrow(/401/)
  })

  it('rejects the handshake with a forged Host (403 before the 101)', async () => {
    await setup()
    await expect(connect({ authorization: `Bearer ${TOKEN}`, host: 'evil.example' })).rejects.toThrow(/403/)
  })

  it('accepts a valid token and delivers hello with the port', async () => {
    await setup()
    // The hello can arrive after `open`; wait on the message, not on open,
    // so the assertion observes the frame rather than a race with its arrival.
    const hello = await new Promise<EditorDownlink>((resolve, reject) => {
      const s = new WebSocket(url(), { headers: { authorization: `Bearer ${TOKEN}` } })
      s.once('error', reject)
      s.once('message', data => {
        s.close()
        resolve(JSON.parse(String(data)) as EditorDownlink)
      })
    })
    expect(hello).toEqual({ type: 'hello', port })
  })

  it('accepts the ?token= query fallback on the handshake', async () => {
    await setup()
    const socket = new WebSocket(`${url()}?token=${TOKEN}`)
    const hello = await new Promise<EditorDownlink>((resolve, reject) => {
      socket.once('open', () => {})
      socket.once('message', data => resolve(JSON.parse(String(data)) as EditorDownlink))
      socket.once('error', reject)
    })
    socket.close()
    expect(hello.type).toBe('hello')
  })

  it('closes binary frames with 1003 (text messages required)', async () => {
    await setup()
    const { socket } = await connect({ authorization: `Bearer ${TOKEN}` })
    try {
      const closed = once(socket, 'close')
      socket.send(Buffer.from([1, 2, 3]))
      const [code] = await closed
      expect(code).toBe(1003)
    } finally {
      socket.close()
    }
  })

  it('closes malformed text frames with 1008', async () => {
    await setup()
    const { socket } = await connect({ authorization: `Bearer ${TOKEN}` })
    try {
      const closed = once(socket, 'close')
      socket.send('not json')
      const [code] = await closed
      expect(code).toBe(1008)
    } finally {
      socket.close()
    }
  })

  it('closes any v1 uplink frame with 1008 (no uplink protocol)', async () => {
    await setup()
    const { socket } = await connect({ authorization: `Bearer ${TOKEN}` })
    try {
      const closed = once(socket, 'close')
      socket.send('{"type":"anything"}')
      const [code] = await closed
      expect(code).toBe(1008)
    } finally {
      socket.close()
    }
  })

  it('broadcasts downlink frames to every open socket', async () => {
    await setup()
    const a = await connect({ authorization: `Bearer ${TOKEN}` })
    const b = await connect({ authorization: `Bearer ${TOKEN}` })
    try {
      const frame: EditorDownlink = { type: 'selection.confirm', sessionId: 's', selection: [{ kind: 'symbol' }] }
      bridge!.broadcast(frame)
      // The frame may arrive before a post-broadcast `once` registers on
      // loopback; the connect-time buffer always catches it.
      await vi.waitFor(() => expect(a.frames).toHaveLength(2))
      await vi.waitFor(() => expect(b.frames).toHaveLength(2))
      expect(JSON.parse(a.frames[1]!)).toEqual(frame)
      expect(JSON.parse(b.frames[1]!)).toEqual(frame)
    } finally {
      a.socket.close()
      b.socket.close()
    }
  })

  it('uses a positive heartbeat interval constant', () => {
    expect(WS_HEARTBEAT_MS).toBeGreaterThan(0)
  })
})
