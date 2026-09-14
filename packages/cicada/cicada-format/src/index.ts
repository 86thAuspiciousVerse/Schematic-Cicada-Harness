/**
 * `cicada-format`: file-format service for Schematic-Cicada schematic files.
 *
 * Provides `cicadaFormat` with {@link parse} (whitelist fail-closed),
 * {@link serialize} (canonical minimal form), and {@link validate}.
 * Pure text-level API: filesystem IO is owned by consumers (runtime commit).
 */

import type { Context } from '@deepseek-ai/cordis'

import { FormatError, parse, parseSexpr } from './read.ts'
import { serialize } from './write.ts'
import { validate } from './validate.ts'
import { tokenize, TokenizeError } from './tokenizer.ts'
import type { SchematicFile, ValidationResult } from './types.ts'

export { FormatError, parse, parseSexpr, serialize, tokenize, TokenizeError, validate }
export * from './constants.ts'
export type * from './types.ts'

/** The format service registered as `cicadaFormat`. */
export class CicadaFormat {
  constructor(public readonly ctx: Context) {}

  /**
   * Parse schematic text into a typed model.
   * @param text - schematic file content.
   * @returns the parsed model; throws {@link FormatError} on malformed or unsupported content.
   */
  parse(text: string): SchematicFile {
    return parse(text)
  }

  /**
   * Serialize a model to canonical schematic text.
   * @param file - the parsed model.
   * @returns canonical `.cicada_sch` text.
   */
  serialize(file: SchematicFile): string {
    return serialize(file)
  }

  /**
   * Validate a model's structural invariants.
   * @param file - the parsed model.
   * @returns validation result (never throws).
   */
  validate(file: SchematicFile): ValidationResult {
    return validate(file)
  }
}

/** Function-plugin entry: registers the `cicadaFormat` service. */
export const name = 'cicada-format'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.provide('cicadaFormat', new CicadaFormat(ctx)))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaFormat: CicadaFormat
  }
}
