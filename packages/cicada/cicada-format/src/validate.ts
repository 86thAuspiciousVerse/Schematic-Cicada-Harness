/**
 * Structure validation over a parsed {@link SchematicFile}.
 *
 * Enforces the invariants the product relies on (8-spec §1.2/§1.4): supported
 * version, self-contained `cicada:` library symbols with well-formed
 * sub-symbol names, unit 1 instances with explicit pins and Reference/Value
 * properties, and unique refdes. Unlike `parse` (token-level fail-closed),
 * `validate` reports all issues without throwing.
 */

import { SUPPORTED_VERSIONS } from './constants.ts'
import type { LibSymbolSpec, SchematicFile, ValidationIssue, ValidationResult } from './types.ts'

/** Validate a parsed schematic model; never throws. */
export function validate(file: SchematicFile): ValidationResult {
  const errors: ValidationIssue[] = []

  if (!SUPPORTED_VERSIONS.includes(file.version as (typeof SUPPORTED_VERSIONS)[number])) {
    errors.push({ code: 'unsupported_version', message: `unsupported schematic version: ${file.version}` })
  }
  if (!file.uuid) errors.push({ code: 'missing_uuid', message: 'missing root uuid' })

  const libIds = new Set<string>()
  for (const lib of file.libSymbols) {
    validateLibSymbol(lib, errors, libIds)
  }

  const refdesSeen = new Set<string>()
  for (const symbol of file.symbols) {
    if (!libIds.has(symbol.libId)) {
      errors.push({ code: 'unknown_lib_id', message: `symbol ${referenceOf(symbol, symbol.uuid)} references unknown lib_id ${symbol.libId}` })
    }
    if (symbol.unit !== 1) errors.push({ code: 'non_unit', message: `symbol ${referenceOf(symbol, symbol.uuid)} has unit ${symbol.unit}, only unit 1 is supported` })
    if (!symbol.uuid) errors.push({ code: 'missing_symbol_uuid', message: `symbol at (${symbol.at.x},${symbol.at.y}) lacks uuid` })
    if (!symbol.properties.Reference) errors.push({ code: 'missing_reference', message: `symbol at (${symbol.at.x},${symbol.at.y}) lacks Reference property` })
    if (!symbol.properties.Value) errors.push({ code: 'missing_value', message: `symbol at (${symbol.at.x},${symbol.at.y}) lacks Value property` })
    if (symbol.pins.length === 0) errors.push({ code: 'no_pins', message: `symbol ${referenceOf(symbol, symbol.uuid)} has no pins` })
    const refdes = symbol.properties.Reference
    if (refdes) {
      if (refdesSeen.has(refdes)) errors.push({ code: 'duplicate_refdes', message: `duplicate refdes: ${refdes}` })
      refdesSeen.add(refdes)
    }
  }

  return { ok: errors.length === 0, errors }
}

function validateLibSymbol(lib: LibSymbolSpec, errors: ValidationIssue[], seen: Set<string>): void {
  if (seen.has(lib.libId)) {
    errors.push({ code: 'duplicate_lib_symbol', message: `duplicate lib_symbols entry: ${lib.libId}` })
  }
  seen.add(lib.libId)
  if (!lib.libId.startsWith('cicada:')) {
    errors.push({ code: 'non_cicada_lib', message: `lib symbol ${lib.libId} is outside the cicada: namespace` })
  }
  const escaped = lib.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namePattern = new RegExp(`^${escaped}_\\d+_\\d+$`)
  for (const child of lib.body.children) {
    const node = child as { head?: string; children?: unknown[] }
    if (typeof node !== 'object' || node === null || node.head !== 'symbol') continue
    const leaf = node.children?.[0] as { type?: string; value?: string } | undefined
    if (!leaf || typeof leaf.value !== 'string') continue
    if (!namePattern.test(leaf.value)) {
      errors.push({ code: 'bad_sub_symbol_name', message: `sub-symbol ${leaf.value} must match ${lib.name}_<unit>_<bodyStyle>` })
    }
  }
  if (lib.pins.length === 0 && !lib.name.startsWith('#')) {
    // Graphic-only markers are allowed (e.g. title blocks); schematic lib symbols need pins.
    // Power symbols must carry exactly one power_in pin at the origin instead.
  }
  const numbers = new Set(lib.pins.map((p) => p.number))
  if (numbers.size !== lib.pins.length) {
    errors.push({ code: 'duplicate_pin_number', message: `lib symbol ${lib.libId} has duplicate pin numbers` })
  }
  if (lib.power && lib.pins.length !== 1) {
    errors.push({ code: 'bad_power_symbol', message: `power symbol ${lib.libId} must have exactly one power_in pin` })
  }
}

function referenceOf(symbol: { properties: Record<string, string> }, fallback: string): string {
  return symbol.properties.Reference || fallback || '(unnamed)'
}
