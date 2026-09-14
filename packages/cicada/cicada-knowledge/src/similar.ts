/**
 * Near-miss lookup for shared-library part numbers (docs/05 §8).
 *
 * The library is keyed by exact part number, so a caller that asks with a
 * slightly different spelling (`AMS1117-3.3` for a stored `AMS1117`, `NE555` for
 * `NE555P`, lower case for an upper-case key) gets `found=false` and no clue
 * about the near miss. Those are DIFFERENT parts and must never be substituted
 * silently, so the answer is a ranked candidate list carrying the reason each
 * one matched, and the caller decides what to do with it.
 */

/** Why a candidate matched, strongest first. */
export type SimilarReason = 'case-or-punctuation' | 'contains' | 'shares-prefix' | 'near-spelling'

/** One near miss of the queried part number. */
export interface SimilarPart {
  part_number: string
  reason: SimilarReason
}

/** Ranking order (the string values are model-visible, so they stay stable). */
const RANK: Record<SimilarReason, number> = {
  'case-or-punctuation': 0,
  contains: 1,
  'shares-prefix': 2,
  'near-spelling': 3,
}

/** A shared prefix shorter than this is noise (`STM` matches half the library). */
const MIN_PREFIX = 4
/** Absolute and relative spelling-distance caps; either one rejects. */
const MAX_DISTANCE = 3
const MAX_DISTANCE_RATIO = 0.25

/** Case- and punctuation-insensitive form every comparison runs on. */
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Levenshtein distance, two rolling rows. */
function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current: number[] = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution)
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

/** Length of the shared leading run of two normalized names. */
function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/** Match reason for one candidate, or undefined when it is not close enough. */
function reasonFor(query: string, candidate: string): SimilarReason | undefined {
  const q = normalize(query)
  const c = normalize(candidate)
  if (q === '' || c === '') return undefined
  if (q === c) return 'case-or-punctuation'
  if (c.includes(q) || q.includes(c)) return 'contains'
  if (commonPrefixLength(q, c) >= MIN_PREFIX) return 'shares-prefix'
  const edits = distance(q, c)
  return edits <= MAX_DISTANCE && edits / Math.max(q.length, c.length) <= MAX_DISTANCE_RATIO
    ? 'near-spelling'
    : undefined
}

/**
 * Rank the near misses of `query` among `candidates`.
 * @param query - the part number the caller asked for.
 * @param candidates - stored part numbers (see `GlobalDatasheetDb.parts`).
 * @param limit - maximum number of candidates returned.
 * @returns candidates close to but NOT equal to `query`, strongest reason first.
 */
export function similarParts(query: string, candidates: readonly string[], limit = 5): SimilarPart[] {
  const found: SimilarPart[] = []
  for (const candidate of candidates) {
    if (candidate === query) continue
    const reason = reasonFor(query, candidate)
    if (reason !== undefined) found.push({ part_number: candidate, reason })
  }
  const lengthGap = (value: string): number => Math.abs(normalize(value).length - normalize(query).length)
  return found
    .sort((left, right) => RANK[left.reason] - RANK[right.reason]
      || lengthGap(left.part_number) - lengthGap(right.part_number)
      || left.part_number.localeCompare(right.part_number))
    .slice(0, limit)
}
