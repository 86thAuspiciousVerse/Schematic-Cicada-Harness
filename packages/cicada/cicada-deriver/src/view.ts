/**
 * Semantic view builder: connectivity -> coordinate-free {@link SemanticModel}.
 * Net naming order per 4-spec §4: label text first, then power Value (global),
 * then `NETn` by dictionary rank of member keys (stable across sessions).
 * Groups with one unlabelled member are left floating (no net).
 */

import type { SchematicFile } from '@deepseek-ai/dsh-cicada-format'

import { deriveConnectivity, type Connectivity, type Group } from './connect.ts'
import { memberKey, netRank, sortMembers } from './naming.ts'
import type { Component, Net, NetMember, NoConnectMember, SemanticModel, WorldPin } from './types.ts'

interface NamedGroup {
  group: Group
  members: NetMember[]
}

/**
 * Derive the coordinate-free semantic model from a parsed schematic file.
 * @param file - parsed schematic.
 * @returns the semantic model (components, nets, no-connects, labels).
 */
export function derive(file: SchematicFile): SemanticModel {
  const conn = deriveConnectivity(file)

  const membersOf = (group: Group): NetMember[] =>
    sortMembers(
      group.memberIds
        .map((id) => conn.pinById.get(id))
        .filter((p): p is WorldPin => p !== undefined)
        .map((p) => ({ refdes: p.refdes, pinName: p.pinName, physicalNumber: p.physicalNumber })),
    )

  const labelled: NamedGroup[] = []
  const powered: NamedGroup[] = []
  const unnamed: NamedGroup[] = []
  for (const group of conn.groups) {
    const members = membersOf(group)
    if (group.labels.length > 0) labelled.push({ group, members })
    else if (group.powerValues.length > 0) powered.push({ group, members })
    else if (members.length >= 2) unnamed.push({ group, members })
    // Single unlabelled members stay floating and appear only in components.
  }

  const unnamedKeys = unnamed.flatMap(({ members }) => (members[0] ? [memberKey(members[0])] : [])).sort()

  const nets: Net[] = []
  for (const { group, members } of labelled) {
    nets.push({ name: group.labels[0] ?? '', members, labelled: true, power: false })
  }
  for (const { group, members } of powered) {
    nets.push({ name: group.powerValues[0] ?? '', members, labelled: false, power: true })
  }
  for (const { members } of unnamed) {
    const first = members[0]
    if (!first) continue
    const key = memberKey(first)
    nets.push({ name: `NET${netRank(key, unnamedKeys)}`, members, labelled: false, power: false })
  }

  const components: Component[] = file.symbols.map((s) => {
    const lib = file.libSymbols.find((entry) => entry.libId === s.libId)
    return {
      refdes: s.properties.Reference ?? s.uuid,
      value: s.properties.Value ?? '',
      libId: s.libId,
      // Pin name = library canonical name (number fallback), so `inspect_component`
      // and every `refdes.pin` token agree on one vocabulary (connect.ts pinName).
      pins: s.pins.map((p) => {
        const spec = lib?.pins.find((candidate) => candidate.number === p.number)
        return {
          number: p.number,
          name: spec === undefined || spec.name === '' || spec.name === '~' ? p.number : spec.name,
        }
      }),
    }
  })

  const noConnects: NoConnectMember[] = conn.pins
    .filter((p) => conn.noConnectKeys.has(`${p.world.x},${p.world.y}`))
    .map((p) => ({ refdes: p.refdes, pinName: p.pinName, physicalNumber: p.physicalNumber }))

  const labels = [...new Set(file.labels.map((l) => l.text))].sort()

  return { components, nets, noConnects, labels }
}

export type { Connectivity }
