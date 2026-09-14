/**
 * Editor-bridge wire contract (9-impl §1.8, P6 定案).
 *
 * THE single alignment point with the wx C++ side (contract-first, P6 定案
 * G-P6-2): endpoints, the `EditorDownlink` frame union, `selectionItem`, the
 * HTTP error code table, and the `baselineHash` semantics. Client-safe: zero
 * node dependencies, pure types + JSON-safe constants, so a client
 * compilation face can reference it.
 *
 * Direction (前后端对接方案 §0/§1.2/§3.3): A-channel wx→host HTTP (POST
 * selection / GET state, `Authorization: Bearer`), B-channel host→wx
 * WebSocket downlink (host is the pusher; wx never sends uplink frames in
 * v1). The WS is NOT `/api/remote.mux` — those events push to the wx canvas,
 * unrelated to the webui.
 */

/** Naming-route prefix owning all editor HTTP endpoints (webserver prefix match includes subpaths). */
export const EDITOR_PATH_PREFIX = '/cicada/editor'
/** POST — accept one canvas selection and inject it into the main agent session. */
export const SELECTION_PATH = '/cicada/editor/selection'
/** GET — state snapshot (port, file, sessionId, lastSelection, baselineHash, warnings). */
export const STATE_PATH = '/cicada/editor/state'

/**
 * GET — the project directory the launcher window started this stack for, read
 * ONCE: the first caller consumes it, so a page reload does not re-open a
 * session (docs/04 §5.2). `{}` once it has been taken or when the stack was
 * started without `--workspace`.
 */
export const INITIAL_WORKSPACE_PATH = '/cicada/editor/initial-workspace'

/** 200 body of GET {@link INITIAL_WORKSPACE_PATH}. */
export interface InitialWorkspaceResponse {
  /** Absolute project directory, absent when there is nothing to adopt. */
  path?: string
}
/** POST — point the engine at the given session's workspace schematic (verified sync; canvas self-heal). */
export const SYNC_PATH = '/cicada/editor/canvas/sync'
/** POST — human canvas gesture lease: take/refresh the editor lock (409 while an agent turn holds it). */
export const ENTER_EDIT_PATH = '/cicada/editor/canvas/enter-edit'
/** POST — release the human canvas gesture lease (idempotent). */
export const LEAVE_EDIT_PATH = '/cicada/editor/canvas/leave-edit'
/** GET — product brand icon (the page's favicon / Edge app-window icon). */
export const BRAND_ICON_PATH = '/cicada/editor/brand/icon.png'
/** GET — product brand mark (the sidebar brand glyph; transparent line art). */
export const BRAND_MARK_PATH = '/cicada/editor/brand/mark.png'
/** WS — exact-path upgrade route; a non-upgrade GET here must be answered 426. */
export const WS_PATH = '/cicada/editor/ws'

/** 200 (or 409) body of {@link ENTER_EDIT_PATH} / {@link LEAVE_EDIT_PATH}. */
export interface LockResponse {
  ok: boolean
  mode: 'idle' | 'agent-editing' | 'human-editing'
}

/** Body of POST {@link SYNC_PATH}. */
export interface EngineSyncRequest {
  /** Target session; omitted = the live main agent, else the newest persisted session with a workspace. */
  sessionId?: string
}

/**
 * 200 body of POST {@link SYNC_PATH}: whether the engine now serves the
 * session's `{cwd}/.cicada/schematic.cicada_sch`. `ok:false` carries a
 * machine-readable {@link EngineSyncResponse.reason}; the canvas reports it and
 * keeps rendering whatever the engine currently holds.
 */
export interface EngineSyncResponse {
  ok: boolean
  /** Absolute schematic path the engine was pointed at, when resolvable. */
  file?: string
  /** Session workspace the path was derived from. */
  cwd?: string
  /** Session the sync targeted. */
  sessionId?: string
  /** Failure cause; absent when `ok`. */
  reason?: 'no-engine' | 'no-session' | 'no-workspace' | 'engine-error'
  /** Engine-side error text when the load failed. */
  error?: string
}

/** One selected schematic object kind (4-spec §7 / 前后端对接方案 §3.1; power symbols fold into `symbol` by value). */
export type SelectionKind = 'symbol' | 'wire' | 'label' | 'no_connect'

/**
 * One selected item (P6 定案 G-P6-3; 3-gaps `nets?` was a typo — the field is
 * `net`, an array of involved net names). All fields JSON-safe; `uuid` is the
 * `.cicada_sch` `(uuid …)` stable reference key (C1).
 */
export interface SelectionItem {
  kind: SelectionKind
  /** Display name; advisory, not a contract (8-spec §2.2). */
  refdes?: string
  /** File-level UUID of the schematic primitive — the stable reference key. */
  uuid?: string
  /** Symbol Value (power-port net names ride here). */
  value?: string
  /** Selected pin (number/name) list, when pins are selected. */
  pins?: string[]
  /** Involved net names, for the network-view local expansion on injection. */
  net?: string[]
}

/** Body of POST {@link SELECTION_PATH}. */
export interface SelectionRequest {
  /** Selected items, in canvas order. */
  selection: SelectionItem[]
  /** Explicit injection target; optional (resolution: body → config `mainSessionId` → root agent). */
  sessionId?: string
  /** Queue for the next user turn instead of interrupting (K6: right-click "加入到上下文" — no mid-turn 插话). */
  attachNextTurn?: boolean
}

/** 200 body of POST {@link SELECTION_PATH}. */
export interface SelectionResponse {
  ok: true
  /** The session that received the injection. */
  sessionId: string
  injected: true
}

/** 200 body of GET {@link STATE_PATH}. */
export interface EditorState {
  /** Listening web port (settle-safe read). */
  port: number
  /** Current schematic file name (single authority: cicada-format constants). */
  file: string
  /** Resolved main agent session id, when a live one exists. */
  sessionId?: string
  /** Session workspace directory (absolute), when a live session exists. */
  cwd?: string
  /** Last injected selection, when any. */
  lastSelection?: SelectionItem[]
  /** sha256 hex of the schematic file bytes (E13-D2), when readable. */
  baselineHash?: string
  /** cicada-engine http port, when the launcher injected CICADA_ENGINE_URL (M1c). */
  enginePort?: number
  /** cicada-engine token (only ever live in the page memory; M1c). */
  engineToken?: string
  /** Editor lock mode as of this snapshot (docs/05 §1); the canvas opens read-only when an agent turn holds it. */
  lock?: 'idle' | 'agent-editing' | 'human-editing'
  /** Non-blocking warnings (file missing, unreadable, …). */
  warnings: string[]
}

/**
 * B-channel downlink frame union (前后端对接方案 §3.3, P6 定案 G-P6-4).
 * v1 emits `hello` / `ping` / `selection.confirm`; the other four frame types
 * are declared (contract + validation) but not emitted until their runtime or
 * knowledge event source lands (P7/M2). v1 defines no uplink frames.
 */
export type EditorDownlink =
  /** Handshake receipt on open (carries the port so wx can cross-check). */
  | { type: 'hello'; port: number; sessionKey?: string }
  /** Runtime watcher notification — declared, not emitted in v1 (P7). */
  | { type: 'canvas.refresh'; file: string; reason: 'ai-write' | 'watcher' | 'baseline' }
  /** Runtime changelog notification — declared, not emitted in v1 (P7). */
  | { type: 'changelog'; seq: number; kind: 'ai_op' | 'user_edit'; summary: string; baselineHash: string }
  /** Baseline advance notification — declared, not emitted in v1 (P7). */
  | { type: 'baseline'; file: string; baselineHash: string }
  /** Datasheet knowledge update — declared, not emitted in v1 (M2). */
  | { type: 'datasheet.update'; partNumber: string; groupId: string; owner: string }
  /** Receipt pushed after a successful POST selection injection. */
  | { type: 'selection.confirm'; sessionId: string; selection: SelectionItem[] }
  /** Editor lock transition (docs/05 §1): canvas renders the read-only overlay. */
  | { type: 'lock'; mode: 'idle' | 'agent-editing' | 'human-editing' }
  /** Heartbeat (host→wx), echo `t` verbatim. */
  | { type: 'ping'; t: number }

/** Editor HTTP error codes (fixed semantics; ordering: trust fence 403 → token 401 → shape 400). */
export const EDITOR_HTTP = {
  /** Request failed the Host/Origin trust fence. */
  FORBIDDEN: 403,
  /** Missing or wrong bearer token. */
  UNAUTHORIZED: 401,
  /** Malformed body / selection item. */
  BAD_REQUEST: 400,
  /** The other side holds the editor lock (canvas lease refused). */
  CONFLICT: 409,
  /** Unknown path under the prefix. */
  NOT_FOUND: 404,
  /** Method not allowed for the path (e.g. GET /selection). */
  METHOD_NOT_ALLOWED: 405,
  /** Plain GET on the WS path (non-upgrade). */
  UPGRADE_REQUIRED: 426,
  /** Request body exceeds the configured limit. */
  PAYLOAD_TOO_LARGE: 413,
  /** Injection failed (no live main agent session, …). */
  INTERNAL_ERROR: 500,
} as const

/** `baselineHash` semantics: sha256 hex of the `.cicada_sch` bytes (E13-D2), recomputed per GET. */
export const BASELINE_ALGORITHM = 'sha256' as const

/**
 * Validate one decoded JSON value as a {@link SelectionItem}.
 * @param value - decoded JSON (lossless; the wire is JSON).
 * @returns the validated item, or undefined when any field is malformed.
 */
export function isSelectionItem(value: unknown): value is SelectionItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (item.kind !== 'symbol' && item.kind !== 'wire' && item.kind !== 'label' && item.kind !== 'no_connect') {
    return false
  }
  if (item.refdes !== undefined && typeof item.refdes !== 'string') return false
  if (item.uuid !== undefined && typeof item.uuid !== 'string') return false
  if (item.value !== undefined && typeof item.value !== 'string') return false
  if (item.pins !== undefined && !(Array.isArray(item.pins) && item.pins.every(p => typeof p === 'string'))) {
    return false
  }
  if (item.net !== undefined && !(Array.isArray(item.net) && item.net.every(n => typeof n === 'string'))) {
    return false
  }
  return true
}

/**
 * Validate a decoded POST {@link SELECTION_PATH} body.
 * @param value - decoded JSON request body.
 * @returns the request, or undefined when malformed.
 */
export function isSelectionRequest(value: unknown): value is SelectionRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  if (!Array.isArray(request.selection) || !request.selection.every(isSelectionItem)) return false
  if (request.sessionId !== undefined && typeof request.sessionId !== 'string') return false
  if (request.attachNextTurn !== undefined && typeof request.attachNextTurn !== 'boolean') return false
  return true
}
