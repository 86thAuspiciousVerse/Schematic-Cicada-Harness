/**
 * Net naming (single authority, 4-spec §4 / E6): labelled nets keep the label
 * text; power nets keep the power Value (global); unnamed nets get `NETn` by
 * dictionary rank over member keys `(refdes, canonicalPinName)`, which is
 * stable across sessions (independent of file order / layout).
 */

import type { NetMember } from './types.ts'

/** Member tie-break key for sorting and ranking. */
export function memberKey(member: NetMember): string {
  return `${member.refdes}.${member.pinName}`
}

/**
 * Rank a member key among the sorted unique keys of all unnamed groups.
 * @param key - the member key to rank.
 * @param sortedKeys - sorted unique member keys of all unnamed nets.
 * @returns 1-based `NETn` number.
 */
export function netRank(key: string, sortedKeys: readonly string[]): number {
  const index = sortedKeys.indexOf(key)
  return index >= 0 ? index + 1 : 1
}

/** Stable sort order for net members: by refdes, then canonical pin name. */
export function sortMembers(members: readonly NetMember[]): NetMember[] {
  return [...members].sort((a, b) => (memberKey(a) < memberKey(b) ? -1 : memberKey(a) > memberKey(b) ? 1 : 0))
}
