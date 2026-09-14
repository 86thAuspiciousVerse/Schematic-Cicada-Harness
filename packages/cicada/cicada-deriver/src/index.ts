/**
 * `cicada-deriver`: semantic model derivation for Schematic-Cicada.
 *
 * Provides `cicadaDeriver` with {@link derive} (coordinate-free view, 4-spec
 * §4), {@link pinWorld} (shared transform authority), and
 * {@link checkInvariants}. Purely read-side: file IO and writes belong to the
 * runtime; this package never mutates.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SchematicFile } from '@deepseek-ai/dsh-cicada-format'

import { deriveConnectivity } from './connect.ts'
import { checkInvariants } from './invariants.ts'
import { memberKey, netRank, sortMembers } from './naming.ts'
import { pinWorld, rotate } from './transform.ts'
import { derive } from './view.ts'
import type { Connectivity, Group } from './connect.ts'
import type { InvariantViolation, SemanticModel } from './types.ts'

export { checkInvariants, derive, deriveConnectivity, memberKey, netRank, pinWorld, rotate, sortMembers }
export type { Connectivity, Group }
export type * from './types.ts'

/** The derivation service registered as `cicadaDeriver`. */
export class CicadaDeriver {
  constructor(public readonly ctx: Context) {}

  /**
   * Derive the coordinate-free semantic model from a parsed schematic file.
   * @param file - parsed schematic.
   * @returns the semantic model.
   */
  derive(file: SchematicFile): SemanticModel {
    return derive(file)
  }

  /**
   * Check derivation-time invariants.
   * @param model - derived semantic model.
   * @returns violations (empty when consistent).
   */
  invariants(model: SemanticModel): InvariantViolation[] {
    return checkInvariants(model)
  }
}

/** Function-plugin entry: registers the `cicadaDeriver` service. */
export const name = 'cicada-deriver'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.provide('cicadaDeriver', new CicadaDeriver(ctx)))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaDeriver: CicadaDeriver
  }
}
