/**
 * One-shot editor bearer token (9-impl §1.8 / §2.6, P6 定案 G-P6-5).
 *
 * Single token, process-lifetime stable, memory only (never config, settings,
 * or logs — K10). Rotation = re-print the `cicada-editor:` stdout line; the
 * launcher StdoutParser override semantics already handle it
 * (`cicada-launcher/src/launcher.ts`). `revoke()` is kept as the API for a
 * future rotation/TTL policy; v1 never calls it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Editor token byte size (mirrors the webui launch token, `browser-auth.ts:52-58`). */
export const TOKEN_BYTES = 32

/** One process-lifetime editor token handle. */
export interface EditorToken {
  /** Base64url token (43 chars for 32 bytes) handed to wx via stdout. */
  readonly token: string
  /** Invalidate this token (v1 API reserved for rotation/TTL). */
  revoke(): void
}

/** Encode bytes as base64url without padding (`browser-auth.ts:36-41` style). */
function encodeBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create the editor token: `randomBytes(32)` → base64url, kept in memory.
 * @returns the token value and its revoke handle.
 */
export function newToken(): EditorToken {
  let token = encodeBase64Url(randomBytes(TOKEN_BYTES))
  return {
    get token(): string {
      return token
    },
    revoke() {
      token = ''
    },
  }
}

/**
 * Constant-time token comparison; length mismatch short-circuits first
 * (`timingSafeEqual` throws on unequal lengths — `browser-auth.ts:100-104`).
 * @param actual - presented token (possibly empty).
 * @param expected - the live token.
 * @returns true only when both match exactly.
 */
export function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

/**
 * Print the editor handoff line, matching the launcher regex
 * `^cicada-editor:\s+(\d+)\s+([A-Za-z0-9_-]+)\s*$`. Call only after the
 * Loader settles (port is defined then — K8); the caller owns the
 * once-per-root guard.
 * @param port - the listening web port.
 * @param token - the editor token.
 */
export function announce(port: number, token: string): void {
  console.log(`cicada-editor: ${String(port)} ${token}`)
}
