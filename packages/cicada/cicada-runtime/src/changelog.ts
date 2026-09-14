/**
 * Changelog diff + baseline snapshot (9-impl §1.4 `changelog`): pure
 * derivation of semantic diffs between two views; file IO belongs to the turn.
 */

import type { SemanticModel } from '@deepseek-ai/dsh-cicada-deriver'

/** The semantic fields needed to compare a persisted baseline with a live view. */
export interface ChangelogView {
  components: { refdes: string; value: string; libId?: string }[]
  nets: { name: string; members: string[] }[]
}

/** The persisted baseline cache. It is recoverable and never the file truth. */
export interface BaselineSnapshot extends ChangelogView {
  savedAt: number
  /** Opaque FsVersion serialized as a string; absent for pre-P7 snapshots. */
  baselineVersion?: string
}

/** One semantic change record appended to `.cicada/changelog.jsonl`. */
export interface ChangelogEntry {
  type: 'ai_op' | 'user_edit' | 'datasheet_update'
  tool: string
  summary: string
  at: number
  /** Monotonic within one workspace changelog; optional for legacy records. */
  seq?: number
}

/** Diff two semantic models into changelog summaries. */
export function diffComponents(before: SemanticModel | ChangelogView, after: SemanticModel | ChangelogView): string[] {
  const lines: string[] = []
  const beforeMap = new Map(before.components.map((c) => [c.refdes, c.value]))
  const afterMap = new Map(after.components.map((c) => [c.refdes, c.value]))
  for (const [refdes, value] of beforeMap) {
    const afterValue = afterMap.get(refdes)
    if (afterValue === undefined) lines.push(`移除 ${refdes}`)
    else if (afterValue !== value) lines.push(`${refdes} 值 ${value} → ${afterValue}`)
  }
  for (const component of after.components) {
    if (!beforeMap.has(component.refdes)) lines.push(`新增 ${component.refdes} (${component.value})`)
  }
  const members = (net: SemanticModel['nets'][number] | ChangelogView['nets'][number]): string[] =>
    net.members.map((member) => typeof member === 'string' ? member : `${member.refdes}.${member.pinName}`)
  // Net membership is a set semantically: editors may serialize pins in a
  // different order without changing the circuit. Compare canonicalized
  // members by net name and report actual additions, updates, and removals.
  const canonicalMembers = (net: SemanticModel['nets'][number] | ChangelogView['nets'][number]): string[] => members(net).sort()
  const beforeNets = new Map(before.nets.map((net) => [net.name, canonicalMembers(net)]))
  const afterNets = new Map(after.nets.map((net) => [net.name, canonicalMembers(net)]))
  for (const [name, netMembers] of afterNets) {
    const previous = beforeNets.get(name)
    if (previous === undefined || previous.join(',') !== netMembers.join(',')) {
      lines.push(`网络 ${name} 更新 (${netMembers.join(', ')})`)
    }
  }
  for (const name of beforeNets.keys()) {
    if (!afterNets.has(name)) lines.push(`网络 ${name} 更新（已移除）`)
  }
  return lines
}

/** Baseline snapshot payload written to `.cicada/view.json`. */
export function baselineSnapshot(model: SemanticModel, baselineVersion?: string): BaselineSnapshot {
  return {
    savedAt: Date.now(),
    ...(baselineVersion === undefined ? {} : { baselineVersion }),
    components: model.components.map((c) => ({ refdes: c.refdes, value: c.value, libId: c.libId })),
    nets: model.nets.map((net) => ({ name: net.name, members: net.members.map((m) => `${m.refdes}.${m.pinName}`) })),
  }
}

/** Validate and normalize a decoded baseline cache. Invalid caches are ignored. */
export function parseBaselineSnapshot(value: unknown): BaselineSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  if (!Array.isArray(source.components) || !Array.isArray(source.nets)) return undefined
  const components: BaselineSnapshot['components'] = []
  for (const item of source.components) {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as Record<string, unknown>
    if (typeof row.refdes !== 'string' || typeof row.value !== 'string') return undefined
    components.push({ refdes: row.refdes, value: row.value, ...(typeof row.libId === 'string' ? { libId: row.libId } : {}) })
  }
  const nets: BaselineSnapshot['nets'] = []
  for (const item of source.nets) {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as Record<string, unknown>
    if (typeof row.name !== 'string' || !Array.isArray(row.members) || !row.members.every((member) => typeof member === 'string')) return undefined
    nets.push({ name: row.name, members: row.members as string[] })
  }
  return {
    savedAt: typeof source.savedAt === 'number' ? source.savedAt : 0,
    ...(typeof source.baselineVersion === 'string' ? { baselineVersion: source.baselineVersion } : {}),
    components,
    nets,
  }
}

/** One oplog line for a performed op (redo intent; 9-impl §1.4). */
export function oplogLine(tool: string, args: unknown, at: number): string {
  return JSON.stringify({ tool, args, at })
}
