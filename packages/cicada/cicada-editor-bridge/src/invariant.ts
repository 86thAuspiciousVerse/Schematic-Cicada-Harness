/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cicada-editor-bridge`.
 * @module @deepseek-ai/dsh-cicada-editor-bridge/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { isSelectionItem } from './contract.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-cicada-editor-bridge'

/** Cordis companion plugin name. */
export const name = 'cicada-editor-bridge-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Owned relation: every emitted `cicada/editor/selection` event carries the
 * validated contract payload (non-empty sessionId + a `SelectionItem[]` that
 * passes the same schema the POST route enforces). A malformed emission would
 * mean a producer bypassed the route's validation and forwarded garbage to
 * the canvas mirror and the wx receipt.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'cicada/editor/selection') return
    const payload = args[0] as { sessionId?: unknown; selection?: unknown } | null | undefined
    if (payload === null || typeof payload !== 'object') {
      fail('cicada/editor/selection payload must be an object')
      return
    }
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      fail('cicada/editor/selection sessionId must be a non-empty string')
      return
    }
    if (!Array.isArray(payload.selection) || payload.selection.some(item => !isSelectionItem(item))) {
      fail('cicada/editor/selection selection must be a validated SelectionItem[]')
    }
  }, { global: true })
}

/**
 * Register the editor-bridge invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
