/**
 * `cicada-erc` host plugin: registers the check service (`cicadaErc`) and
 * writes `.cicada/warnings.json` on demand. Warnings are advisory only.
 */

import type { Context } from '@deepseek-ai/cordis'

import { run, type Warning } from './checks.ts'

export { run, runChecks, setErcEngine, type ErcEngine, type Warning, type WarningCode } from './checks.ts'

/** The registered service (`ctx.cicadaErc`). */
export class CicadaErc {
  constructor(public readonly ctx: Context) {}

  /** Run the checks (pure; no file IO). */
  check(file: Parameters<typeof run>[0]): Warning[] {
    return run(file)
  }
}

export const name = 'cicada-erc'
export const inject = ['fs', 'cicadaFormat']

export function apply(ctx: Context): void {
  const service = new CicadaErc(ctx)
  ctx.effect(() => ctx.provide('cicadaErc', service))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaErc: CicadaErc
  }
}
