import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-cicada-layout'

export const name = 'client-ui-cicada-layout-invariant'
export const inject = ['invariants']

/** No runtime invariant: a single root-frame registration whose disposal is proven by the HMR-safety spec. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
