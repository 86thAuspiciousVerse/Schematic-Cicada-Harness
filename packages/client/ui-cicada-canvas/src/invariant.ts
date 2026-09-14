import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-cicada-canvas'

export const name = 'client-ui-cicada-canvas-invariant'
export const inject = ['invariants']

/** No runtime invariant: the v1 placeholder contributes no live subscriptions; P6 adds the selection mirror. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
