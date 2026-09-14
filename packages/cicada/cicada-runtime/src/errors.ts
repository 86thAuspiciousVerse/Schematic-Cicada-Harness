/**
 * Error-code single authority for the Schematic-Cicada write tools
 * (4-spec §5.3). Every write-broken condition maps onto exactly one code here;
 * tool schemas, op implementations, and tests all read this vocabulary.
 *
 * @module
 */

/** Stable machine-routable error codes (4-spec §5.3 + the four v1 additions). */
export const ERROR_CODES = [
  // 4-spec §5.3 inherited vocabulary
  'duplicate_refdes',
  'unknown_refdes',
  'unknown_pin',
  'endpoint_resolution_failed',
  'connected_endpoint',
  'duplicate_endpoint',
  'endpoint_not_connected',
  'endpoint_in_multiple_nets',
  'too_few_endpoints',
  'no_connect_conflict',
  'no_connect_missing',
  'cross_network_conflict',
  'duplicate_net_name',
  'unknown_net',
  'expected_net_mismatch',
  'net_role_compare_failed',
  'net_role_conflict',
  // v1 additions (4-spec §5.3 "新增")
  'symbol_unsupported',
  'datasheet_missing',
  'path_not_found',
  'pin_universe_incomplete',
  // 2026-09-08 晚：编辑器互斥锁（docs/05 §1）——人侧持锁时 AI 写工具被拒。
  'editor_busy',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Typed runtime failure carrying the stable {@link ErrorCode}. */
export class CicadaError extends HarnessError {
  override readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message, code)
    this.name = 'CicadaError'
    this.code = code
  }
}

/**
 * Coerce an unknown throw into a CicadaError with a fallback code.
 * @param error - the caught value.
 * @param fallback - code when the value is not already a CicadaError.
 * @returns the normalized runtime error.
 */
export function toCicadaError(error: unknown, fallback: ErrorCode): CicadaError {
  return error instanceof CicadaError ? error : new CicadaError(fallback, error instanceof Error ? error.message : String(error))
}

/** Whether a code is part of the single-authority vocabulary. */
export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value)
}
