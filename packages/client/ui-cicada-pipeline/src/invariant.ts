import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-cicada-pipeline'

export const name = 'client-ui-cicada-pipeline-invariant'
export const inject = ['invariants']

/** No runtime invariant: the event-feed subscription lifecycle is proven by the HMR-safety spec. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
