/**
 * `cicada-symbols`: symbol generation for Schematic-Cicada.
 *
 * Provides `cicadaSymbols` with the deterministic geometry (`icBox`,
 * `icPins`), template builders (`buildTemplate`), the datasheet pin-universe
 * guard (`pinUniverse`), and the global cache (`SymbolCache`, root injected by
 * the caller — never an absolute path constant). Pure side: file writing of
 * schematic files stays in the runtime; only the global symbol cache touches
 * disk here, and only through an injected directory.
 */

import type { Context } from '@deepseek-ai/cordis'

import { SymbolCache } from './cache.ts'
import { electricalToEngine, ENGINE_ELECTRICAL_TYPES, ENGINE_SIDES, pinUniverse, sideToEngine } from './datasheet.ts'
import { icBox, icPins } from './geometry.ts'
import { buildTemplate } from './templates.ts'
import type { TemplateSymbol } from './templates.ts'

export { SymbolCache, buildTemplate, electricalToEngine, ENGINE_ELECTRICAL_TYPES, ENGINE_SIDES, icBox, icPins, pinUniverse, sideToEngine }
export type * from './types.ts'

/** The symbol service registered as `cicadaSymbols`. */
export class CicadaSymbols {
  /** @param ctx - host context. */
  constructor(public readonly ctx: Context) {}

  /** Build a template symbol by kind (returns canonical lib entry + pins). */
  template(kind: 'sym2' | 'polar2' | 'tri' | 'connector' | 'power', name: string, opts?: { names?: readonly string[]; n?: number; type?: string }): TemplateSymbol {
    return buildTemplate(kind, name, opts)
  }

  /** Open a symbol cache rooted at the caller-resolved directory. */
  cache(root: string): SymbolCache {
    return new SymbolCache(root)
  }
}

/** Function-plugin entry: registers the `cicadaSymbols` service. */
export const name = 'cicada-symbols'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.provide('cicadaSymbols', new CicadaSymbols(ctx)))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaSymbols: CicadaSymbols
  }
}
