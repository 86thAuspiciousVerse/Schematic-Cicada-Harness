/**
 * Pin-universe guard (E11 / 4-spec §3.3): merge candidate pins from datasheet
 * groups by physical number (first-wins), then reject on missing, duplicate,
 * or gap conditions — an incomplete universe forbids symbol generation.
 */

import type { PinObservation, PinUniverseResult } from './types.ts'

/**
 * Merge pin observations across groups into the pin universe.
 * @param groups - candidate pins per datasheet group.
 * @param expected - expected pin count (soft check when positive).
 * @returns the merged universe with completeness verdict.
 */
export function pinUniverse(groups: readonly (readonly PinObservation[])[], expected = 0): PinUniverseResult {
  const pins = new Map<string, PinObservation>()
  const seen = new Map<string, number>()
  for (const group of groups) {
    for (const candidate of group) {
      const key = candidate.physicalNumber
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (!pins.has(key)) pins.set(key, candidate)
    }
  }
  const numbers = [...pins.keys()].map((k) => Number.parseInt(k, 10)).sort((a, b) => a - b)
  const first = numbers[0]
  const hasDup = [...seen.values()].some((count) => count > 1)
  const hasGap = first !== undefined && numbers.length > 1 && numbers.some((v, i) => first + i !== v)
  // Physical numbering starts at 1 (8-spec §2.5): a non-1 start (e.g. 2..n)
  // would pass continuity but leave the icLibText slot mapping degenerate.
  const startsAtOne = first === undefined || first === 1
  if (numbers.length === 0 || numbers.includes(Number.NaN) || hasDup || hasGap || !startsAtOne || (expected > 0 && numbers.length < expected)) {
    return { pins, complete: false, errorCode: 'pin_universe_incomplete' }
  }
  return { pins, complete: true }
}

/**
 * Engine electrical vocabulary — the mirror of `shape_synth`'s
 * `kElectricalSet` in `cicada-engine`. Values already in this set pass through
 * untouched: `power_out` matters (datasheet artifacts author it, e.g. AMS1117
 * VOUT) and collapsing it to `unspecified` would flatten the netlist's power
 * direction.
 */
export const ENGINE_ELECTRICAL_TYPES = [
  'input', 'output', 'power_in', 'power_out', 'bidirectional', 'passive', 'unspecified',
] as const

/** Informal datasheet spellings → engine vocabulary. */
const DATASHEET_ELECTRICAL_ALIASES: Record<string, string> = {
  in: 'input',
  out: 'output',
  power: 'power_in',
  ground: 'power_in',
  bidir: 'bidirectional',
}

/**
 * Normalize a datasheet pin direction to the vocabulary the engine accepts.
 * The single implementation: the runtime builds shape blocks with it and the
 * launcher's symbol rebuild posts shape blocks to `/lib/synthesize` with it.
 * @param type - datasheet-side electrical value (any spelling, may be absent).
 * @returns an engine electrical type; unknown values become `unspecified`.
 */
export function electricalToEngine(type: string | undefined): string {
  const normalized = (type ?? 'passive').toLowerCase()
  if ((ENGINE_ELECTRICAL_TYPES as readonly string[]).includes(normalized)) return normalized
  return DATASHEET_ELECTRICAL_ALIASES[normalized] ?? 'unspecified'
}

/** Engine side vocabulary (`shape_synth`'s `kSideSet`). */
export const ENGINE_SIDES = ['left', 'right', 'top', 'bottom'] as const

/**
 * Normalize a datasheet-authored pin side to the engine vocabulary.
 *
 * Artifacts in the wild carry single-letter or capitalized forms (`L`, `B`,
 * `Right`) — measured 2026-09-13: a datasheet subagent wrote `L/B/R/T` for a
 * 48-pin LQFP symbol, and `/lib/synthesize` refused the whole block. Only the
 * four canonical values are accepted; anything else is returned unchanged so the
 * engine still rejects it loudly instead of us inventing a side.
 * @param side - authored side value (any spelling, may be absent).
 * @returns a canonical side, or the trimmed input when it is not recognized.
 */
export function sideToEngine(side: string | undefined): string | undefined {
  if (side === undefined) return undefined
  const trimmed = side.trim()
  if (trimmed === '') return undefined
  const lower = trimmed.toLowerCase()
  if ((ENGINE_SIDES as readonly string[]).includes(lower)) return lower
  const aliases: Record<string, string> = { l: 'left', r: 'right', t: 'top', b: 'bottom' }
  return aliases[lower] ?? trimmed
}
