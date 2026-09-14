/**
 * Editor HTTP control plane (9-impl §1.8 / P6 定案).
 *
 * One `prefix` route owns every `/cicada/editor/*` endpoint (webserver prefix
 * matching includes subpaths). Two-stage fence, in order (403 → 401, same as
 * `requestRejection`): Host/Origin trust fence, then the bearer token. The WS
 * path answered 426 for non-upgrade requests (upgrade dispatch is separate
 * and exact-only; see ws.ts). All dependencies arrive through
 * {@link EditorBridgeDeps} so the pure HTTP semantics are unit-testable
 * without a live composition.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedApiRequest } from '@deepseek-ai/dsh-client-connection/src/api-request-trust.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  BRAND_ICON_PATH,
  INITIAL_WORKSPACE_PATH,
  BRAND_MARK_PATH,
  EDITOR_HTTP,
  ENTER_EDIT_PATH,
  LEAVE_EDIT_PATH,
  SELECTION_PATH,
  STATE_PATH,
  SYNC_PATH,
  WS_PATH,
  isSelectionRequest,
  type EditorState,
  type EngineSyncResponse,
  type LockResponse,
  type SelectionItem,
  type SelectionResponse,
} from './contract.ts'

/** State-snapshot session identity: a live session or a cold record's minimal identity. */
export interface StateSessionRef {
  id: string
  header: { cwd?: string }
}

/** Everything the route handler needs besides pure HTTP; assembled in index.ts, mocked in tests. */
export interface EditorBridgeDeps {
  /** Non-loopback authorities allowed past the trust fence (loopback is implicitly trusted). */
  readonly trustedHosts: readonly string[]
  /** Constant-time token check against the presented credential. */
  matchesToken(presented: string | undefined): boolean
  /** Resolve the injection target session (body id → config → root agent); undefined when no live agent. */
  resolveSession(requested?: string): Session | undefined
  /** State-snapshot session: live target first, else the newest persisted record with a cwd (editor needs cwd even before the session is resumed). */
  readStateSession(): Promise<StateSessionRef | undefined>
  /** Deferred queue (right-click 加入到上下文): cold sessions allowed; delivered with the next user turn. */
  queueSelection(sessionId: string, selection: SelectionItem[]): void
  /** Immediate injection into a live session (followup needs the live handle). */
  injectSelection(session: Session, selection: SelectionItem[]): void
  /** sha256 hex of the schematic file bytes (E13-D2), undefined when unreadable. */
  readBaseline(session: StateSessionRef): Promise<string | undefined>
  /**
   * Make the engine serve one session's workspace schematic (POST /document,
   * verified against the engine's current document). Absent = no engine wired.
   */
  syncEngineDocument?(sessionId?: string): Promise<EngineSyncResponse>
  /** Human canvas lease: take/refresh (409 when an agent turn holds the lock). Absent = no lock wired. */
  enterEdit?(): LockResponse
  /** Human canvas lease: release (idempotent). Absent = no lock wired. */
  leaveEdit?(): LockResponse
  /** Current lock mode for the state snapshot; absent = no lock wired. */
  lockMode?(): 'idle' | 'agent-editing' | 'human-editing'
  /**
   * Take the launcher's initial project directory, if this stack was started for
   * one. One-shot by contract: the first read consumes it.
   */
  takeInitialWorkspace?(): string | undefined
  /** Product brand icon bytes (favicon / app-window icon); absent or undefined = 404. */
  brandIcon?(): { body: Buffer; contentType: string } | undefined
  /** Product brand mark bytes (sidebar glyph); absent or undefined = 404. */
  brandMark?(): { body: Buffer; contentType: string } | undefined
  /** Engine port/token from the launcher (CICADA_ENGINE_URL/TOKEN); undefined = no engine (M1c). */
  readonly engine?: { port: number; token: string }
  /** Current web port (settle-safe). */
  port(): number
  /** Schematic file display name (single authority: cicada-format constants). */
  readonly schematicFileName: string
  /** Request body byte limit (413 past it). */
  readonly maxRequestBodyBytes: number
}

/** Extract the bearer token from an Authorization header, or undefined. */
export function extractBearer(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  if (!authorization.startsWith('Bearer ')) return undefined
  const value = authorization.slice('Bearer '.length)
  return value.length > 0 ? value : undefined
}

/** Extract the HTTP `?token=` fallback (used only for GET /state by this route). */
export function extractQueryToken(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined
  const token = new URL(rawUrl, 'http://x').searchParams.get('token')
  return token !== null && token.length > 0 ? token : undefined
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        // Keep draining (never destroy the socket: the client must receive
        // the 413 response) but stop buffering.
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new BodyTooLargeError())
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(text) as unknown)
      } catch {
        reject(new BodyParseError())
      }
    })
    req.on('error', reject)
  })
}

/** Request body exceeded {@link EditorBridgeDeps.maxRequestBodyBytes}. */
class BodyTooLargeError extends Error {
  constructor() {
    super('editor bridge: request body too large')
  }
}

/** Request body was not valid JSON. */
class BodyParseError extends Error {
  constructor() {
    super('editor bridge: request body is not JSON')
  }
}

/**
 * Create the prefix-route handler owning the full response lifecycle.
 * @param deps - assembled editor-bridge dependencies.
 * @returns a webserver route handler for {@link SELECTION_PATH} and friends.
 */
export function createEditorRouteHandler(deps: EditorBridgeDeps): WebRoute['handler'] {
  return async (req, res) => {
    // Stage 1: Host/Origin trust fence (loopback implicitly trusted).
    if (!isTrustedApiRequest(req, deps.trustedHosts)) {
      json(res, EDITOR_HTTP.FORBIDDEN, { error: 'forbidden' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    // Stage 2: bearer token. M1c 浏览器同源放行：/state 与 /selection 对同源
    // 页面（sec-fetch-site same-origin/none，Stage 1 trust gate 已过）不再要求
    // editor token——页面的 DSH web token 与 editor token 互不相同，画布前端
    // 无法持有后者；跨端（exe 等）仍走 Authorization/查询（防漂移）。
    const browserSameOrigin = req.headers['sec-fetch-site'] === 'same-origin'
      || req.headers['sec-fetch-site'] === 'none'
    const browserProbe = browserSameOrigin
      && (pathname === STATE_PATH
        || (req.method === 'GET' && pathname === INITIAL_WORKSPACE_PATH)
        || (req.method === 'GET' && (pathname === BRAND_ICON_PATH || pathname === BRAND_MARK_PATH))
        || (req.method === 'POST'
          && (pathname === SELECTION_PATH
            || pathname === SYNC_PATH
            || pathname === ENTER_EDIT_PATH
            || pathname === LEAVE_EDIT_PATH)))
    const queryFallbackAllowed = req.method === 'GET' && pathname === STATE_PATH
    const presented = extractBearer(req.headers.authorization)
      ?? ((browserSameOrigin || queryFallbackAllowed) ? extractQueryToken(req.url) : undefined)
    if (!deps.matchesToken(presented) && !browserProbe) {
      json(res, EDITOR_HTTP.UNAUTHORIZED, { error: 'unauthorized' })
      return
    }

    // The WS path exists only for upgrades; any plain HTTP request is refused
    // (upgrade dispatch never reaches this handler — P6-3/P6-10).
    if (pathname === WS_PATH) {
      json(res, EDITOR_HTTP.UPGRADE_REQUIRED, { error: 'upgrade required' })
      return
    }
    if (pathname === SELECTION_PATH) {
      if (req.method !== 'POST') {
        json(res, EDITOR_HTTP.METHOD_NOT_ALLOWED, { error: 'method not allowed' })
        return
      }
      await handleSelection(req, res, deps)
      return
    }
    if (pathname === INITIAL_WORKSPACE_PATH) {
      // One-shot: the first reader (the page's first load) consumes it, so
      // reloading the product page does not open another session.
      const path = deps.takeInitialWorkspace?.()
      json(res, 200, path === undefined || path === '' ? {} : { path })
      return
    }

    if (pathname === STATE_PATH) {
      if (req.method !== 'GET') {
        json(res, EDITOR_HTTP.METHOD_NOT_ALLOWED, { error: 'method not allowed' })
        return
      }
      await handleState(res, deps)
      return
    }
    if (pathname === SYNC_PATH) {
      if (req.method !== 'POST') {
        json(res, EDITOR_HTTP.METHOD_NOT_ALLOWED, { error: 'method not allowed' })
        return
      }
      await handleSync(req, res, deps)
      return
    }
    if (pathname === ENTER_EDIT_PATH || pathname === LEAVE_EDIT_PATH) {
      if (req.method !== 'POST') {
        json(res, EDITOR_HTTP.METHOD_NOT_ALLOWED, { error: 'method not allowed' })
        return
      }
      const enter = pathname === ENTER_EDIT_PATH
      const result = enter ? deps.enterEdit?.() : deps.leaveEdit?.()
      // No lock wired = 回退安全: report idle so the canvas stays editable.
      const response: LockResponse = result ?? { ok: true, mode: 'idle' }
      json(res, response.ok ? 200 : EDITOR_HTTP.CONFLICT, response)
      return
    }
    if (pathname === BRAND_ICON_PATH || pathname === BRAND_MARK_PATH) {
      if (req.method !== 'GET') {
        json(res, EDITOR_HTTP.METHOD_NOT_ALLOWED, { error: 'method not allowed' })
        return
      }
      const asset = pathname === BRAND_ICON_PATH ? deps.brandIcon?.() : deps.brandMark?.()
      if (asset === undefined) {
        json(res, EDITOR_HTTP.NOT_FOUND, { error: 'not found' })
        return
      }
      res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-cache' })
      res.end(asset.body)
      return
    }
    json(res, EDITOR_HTTP.NOT_FOUND, { error: 'not found' })
  }
}

async function handleSelection(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EditorBridgeDeps,
): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req, deps.maxRequestBodyBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      json(res, EDITOR_HTTP.PAYLOAD_TOO_LARGE, { error: 'payload too large' })
      return
    }
    json(res, EDITOR_HTTP.BAD_REQUEST, { error: 'body is not JSON' })
    return
  }
  if (!isSelectionRequest(body)) {
    json(res, EDITOR_HTTP.BAD_REQUEST, { error: 'invalid selection request' })
    return
  }
  let targetSessionId: string | undefined
  if (body.attachNextTurn === true) {
    // Deferred: only the session id is needed — the target may be cold (agent
    // not resumed under this host); the batch rides the next user turn.
    const requested = body.sessionId
    if (requested === undefined) {
      json(res, EDITOR_HTTP.INTERNAL_ERROR, { error: 'no main agent session' })
      return
    }
    targetSessionId = requested
    deps.queueSelection(requested, body.selection)
  } else {
    const session = deps.resolveSession(body.sessionId)
    if (session === undefined) {
      json(res, EDITOR_HTTP.INTERNAL_ERROR, { error: 'no main agent session' })
      return
    }
    targetSessionId = session.id
    deps.injectSelection(session, body.selection)
  }
  const response: SelectionResponse = { ok: true, sessionId: targetSessionId, injected: true }
  json(res, 200, response)
}

async function handleState(res: ServerResponse, deps: EditorBridgeDeps): Promise<void> {
  const warnings: string[] = []
  let sessionId: string | undefined
  let baselineHash: string | undefined
  const session = await deps.readStateSession()
  if (session !== undefined) {
    sessionId = session.id
    baselineHash = await deps.readBaseline(session)
    if (baselineHash === undefined) warnings.push('schematic file missing or unreadable')
  } else {
    warnings.push('no main agent session')
  }
  const state: EditorState = {
    port: deps.port(),
    file: deps.schematicFileName,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(session !== undefined && session.header.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    ...(baselineHash !== undefined ? { baselineHash } : {}),
    ...(deps.engine !== undefined ? { enginePort: deps.engine.port } : {}),
    ...(deps.engine !== undefined ? { engineToken: deps.engine.token } : {}),
    ...(deps.lockMode !== undefined ? { lock: deps.lockMode() } : {}),
    warnings,
  }
  json(res, 200, state)
}

/**
 * Canvas-driven engine-document sync. The canvas calls this when it mounts (and
 * after an engine conflict), so the engine serves the workspace of the session
 * the canvas is showing without waiting for a user turn. Body is optional;
 * malformed non-empty JSON is a 400, an empty body means "resolve the main
 * session".
 */
async function handleSync(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EditorBridgeDeps,
): Promise<void> {
  let sessionId: string | undefined
  try {
    const body = await readOptionalBody(req, deps.maxRequestBodyBytes)
    if (body !== undefined) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        json(res, EDITOR_HTTP.BAD_REQUEST, { error: 'invalid sync request' })
        return
      }
      const requested = (body as { sessionId?: unknown }).sessionId
      if (requested !== undefined && (typeof requested !== 'string' || requested === '')) {
        json(res, EDITOR_HTTP.BAD_REQUEST, { error: 'invalid sync request' })
        return
      }
      sessionId = requested
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      json(res, EDITOR_HTTP.PAYLOAD_TOO_LARGE, { error: 'payload too large' })
      return
    }
    json(res, EDITOR_HTTP.BAD_REQUEST, { error: 'body is not JSON' })
    return
  }
  if (deps.syncEngineDocument === undefined) {
    json(res, 200, { ok: false, reason: 'no-engine' } satisfies EngineSyncResponse)
    return
  }
  const result = await deps.syncEngineDocument(sessionId)
  json(res, 200, result)
}

/** Like {@link readBody} but resolves undefined for an empty body (optional-body endpoints). */
async function readOptionalBody(req: IncomingMessage, limit: number): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BodyParseError()
  }
}
