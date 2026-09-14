/**
 * Editor WebSocket downlink (9-impl §1.8 / P6 定案 G-P6-4).
 *
 * The B channel: host pushes frames to the wx canvas; wx never sends uplink
 * frames in v1. Registered as an exact-path upgrade route (upgrade dispatch
 * is exact-only and separate from HTTP routing — P6-3); both trust fences run
 * BEFORE the 101 handshake, with a hand-written HTTP rejection
 * (gateway `stream-server.ts:197-208` style). v1 emits `hello` / `ping` /
 * `selection.confirm`; the other declared frame types stay un-emitted until
 * their runtime/knowledge event lands (P7/M2). Any v1 uplink frame is a
 * protocol violation and closes the socket (fail closed).
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { isTrustedApiRequest } from '@deepseek-ai/dsh-client-connection/src/api-request-trust.ts'
import { WS_PATH, type EditorDownlink } from './contract.ts'

/** Heartbeat interval for connected wx sockets. */
export const WS_HEARTBEAT_MS = 30_000

/** One ws bridge over the live token + trust fence. */
export interface WsBridge {
  /** Push one downlink frame to every open wx socket. */
  broadcast(frame: EditorDownlink): void
  /** Unregister the upgrade route, terminate sockets, and close the server. */
  dispose(): void
}

/** Trust/token fence shared by the upgrade handler. */
export interface WsBridgeDeps {
  readonly trustedHosts: readonly string[]
  matchesToken(presented: string | undefined): boolean
  /** Current web port (settle-safe; carried on `hello`). */
  port(): number
}

/** Reject an upgrade before the 101 by writing a plain HTTP response on the socket. */
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

/** Whether a decoded JSON value is a plain object (null excluded). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Exact-key set check (gateway `stream-protocol.ts:294-298` style): a frame
 * must carry exactly the declared keys so unknown fields cannot smuggle
 * meaning.
 */
export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

/**
 * Parse one WS text frame as a JSON record; throws on non-JSON or non-object.
 * @param text - one text frame payload.
 * @returns the decoded record.
 */
export function parseFrame(text: string): Record<string, unknown> {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('editor bridge: WS frame is not JSON', { cause })
  }
  if (!isRecord(decoded)) throw new Error('editor bridge: WS frame must be an object')
  return decoded
}

/**
 * Register the exact-path WS upgrade route.
 * @param deps - fence + port dependencies.
 * @returns the bridge (broadcast + dispose) and the upgrade route to register.
 */
export function createWsBridge(deps: WsBridgeDeps): { bridge: WsBridge; route: WebUpgradeRoute } {
  const server = new WebSocketServer({ noServer: true })
  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.ping()
    }
  }, WS_HEARTBEAT_MS)
  heartbeat.unref()

  const route: WebUpgradeRoute = {
    path: WS_PATH,
    handler: (req, socket, head) => {
      // Both fences run before `handleUpgrade` writes the 101.
      if (!isTrustedApiRequest(req, deps.trustedHosts)) {
        rejectUpgrade(socket, 403)
        return
      }
      // M1c 浏览器同源放行（与 routes.ts 同规则）：页面无法持有 editor token。
      const browserSameOrigin = req.headers['sec-fetch-site'] === 'same-origin'
        || req.headers['sec-fetch-site'] === 'none'
      const presented = extractUpgradeToken(req)
      if (!deps.matchesToken(presented) && !browserSameOrigin) {
        rejectUpgrade(socket, 401)
        return
      }
      server.handleUpgrade(req, socket, head, (websocket) => {
        server.emit('connection', websocket, req)
      })
    },
  }

  server.on('connection', (socket) => {
    const hello: EditorDownlink = { type: 'hello', port: deps.port() }
    socket.send(JSON.stringify(hello))
    // v1 defines no uplink frames: any application frame is a violation
    // (fail closed). ws-level pong replies never surface here.
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, 'text messages required')
        return
      }
      try {
        parseFrame(data.toString())
      } catch {
        socket.close(1008, 'invalid frame')
        return
      }
      socket.close(1008, 'no uplink frames in v1')
    })
  })

  const bridge: WsBridge = {
    broadcast(frame: EditorDownlink): void {
      const text = JSON.stringify(frame)
      for (const socket of server.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text)
      }
    },
    dispose(): void {
      clearInterval(heartbeat)
      for (const socket of server.clients) socket.terminate()
      server.close()
    },
  }
  return { bridge, route }
}

/** Extract the WS handshake token: `Authorization: Bearer` first, `?token=` fallback. */
function extractUpgradeToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const value = authorization.slice('Bearer '.length)
    if (value.length > 0) return value
  }
  const query = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  return query !== null && query.length > 0 ? query : undefined
}
