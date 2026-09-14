/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cicada-runtime`.
 * @module @deepseek-ai/dsh-cicada-runtime/invariant
 *
 * Runtime state is owned by the workspace filesystem and the turn manager;
 * there is no runtime-global event relation that can be checked independently
 * of a concrete filesystem and agent. The companion therefore registers the
 * package with the invariant host but intentionally installs no listener.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cicada-runtime'

/** Cordis companion plugin name. */
export const name = 'cicada-runtime-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

const install: InvariantInstaller = () => undefined

/**
 * Register the runtime invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
