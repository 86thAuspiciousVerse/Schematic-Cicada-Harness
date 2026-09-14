/**
 * Connectivity graph: geometric grouping of sheet pins, wire endpoints,
 * label anchors, and power anchors by exact integer coordinate equality
 * (`sch_line.cpp:754-757` semantics), then label-text and power-Value joining
 * for named nets. Junctions are ignored (E3-5).
 */

import type { CoordG, SchematicFile } from '@deepseek-ai/dsh-cicada-format'

import { pinWorld } from './transform.ts'
import type { WorldPin } from './types.ts'

/** One connected group identity before naming. */
export interface Group {
  /** Root key of the union-find component. */
  root: string
  /** Pin ids (`refdes.pinName`) in this group. */
  memberIds: string[]
  /** Label texts anchored in this group. */
  labels: string[]
  /** Power net values whose power pins land in this group. */
  powerValues: string[]
}

/** Result of geometric connectivity derivation. */
export interface Connectivity {
  /** Every sheet pin with its world coordinate. */
  pins: WorldPin[]
  /** Pins by pin id. */
  pinById: Map<string, WorldPin>
  /** Connected groups keyed by root. */
  groups: Group[]
  /** Coordinate keys carrying a no_connect marker. */
  noConnectKeys: Set<string>
}

const keyOf = (p: CoordG): string => `${p.x === 0 ? 0 : p.x},${p.y === 0 ? 0 : p.y}`

/** Minimal union-find over coordinate keys. */
class UnionFind {
  private parent = new Map<string, string>()

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key)
  }

  find(key: string): string {
    let root = key
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string
    let cur = key
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

/** Derive connectivity groups for a parsed schematic file. */
export function deriveConnectivity(file: SchematicFile): Connectivity {
  const libByLibId = new Map(file.libSymbols.map((l) => [l.libId, l]))
  const uf = new UnionFind()
  const pins: WorldPin[] = []
  const pinById = new Map<string, WorldPin>()
  const pinByKey = new Map<string, WorldPin[]>()
  const labelByKey = new Map<string, string>()
  const powerValueByKey = new Map<string, string>()

  for (const symbol of file.symbols) {
    const lib = libByLibId.get(symbol.libId)
    if (!lib) continue
    const refdes = symbol.properties.Reference ?? symbol.uuid
    // Power anchors: the lib `(power)` flag is authoritative, but a symbol whose
    // Reference is the KiCad power convention `#PWR*` is one too — engine
    // saveback used to drop `(power)` and silently turned GND/+5V into NETn
    // (2026-09-08 验收实测). Keep both signals so the semantic layer survives
    // either dialect.
    const isPower = lib.power || /^#PWR/i.test(refdes)
    const powerValue = isPower ? (symbol.properties.Value ?? '') : ''
    for (const pinSpec of lib.pins) {
      const world = pinWorld(symbol.at, symbol.rotation, pinSpec.at)
      const pin: WorldPin = {
        refdes,
        pinName: pinSpec.name !== '' && pinSpec.name !== '~' ? pinSpec.name : pinSpec.number,
        physicalNumber: pinSpec.number,
        world,
      }
      const id = `${refdes}.${pin.pinName}`
      const key = keyOf(world)
      pins.push(pin)
      pinById.set(id, pin)
      uf.add(key)
      const bucket = pinByKey.get(key) ?? []
      bucket.push(pin)
      pinByKey.set(key, bucket)
      if (isPower) powerValueByKey.set(key, powerValue)
    }
  }

  for (const wire of file.wires) {
    const a = keyOf(wire.pts[0])
    const b = keyOf(wire.pts[1])
    uf.add(a)
    uf.add(b)
    uf.union(a, b)
  }

  for (const label of file.labels) {
    const key = keyOf(label.at)
    uf.add(key)
    labelByKey.set(key, label.text)
  }

  const noConnectKeys = new Set(file.noConnects.map((nc) => keyOf(nc.at)))

  // Join same-text labels across places, then same-value power anchors (global nets).
  const textByLabel = new Map<string, string[]>()
  for (const [key, text] of labelByKey) {
    const list = textByLabel.get(text) ?? []
    list.push(key)
    textByLabel.set(text, list)
  }
  for (const keys of textByLabel.values()) {
    const first = keys[0]
    if (first === undefined) continue
    for (const key of keys.slice(1)) uf.union(first, key)
  }
  const valueByPower = new Map<string, string[]>()
  for (const [key, value] of powerValueByKey) {
    const list = valueByPower.get(value) ?? []
    list.push(key)
    valueByPower.set(value, list)
  }
  for (const keys of valueByPower.values()) {
    const first = keys[0]
    if (first === undefined) continue
    for (const key of keys.slice(1)) uf.union(first, key)
  }

  // Group assembly.
  const groupByRoot = new Map<string, Group>()
  for (const pin of pins) {
    const root = uf.find(keyOf(pin.world))
    const group = groupByRoot.get(root) ?? { root, memberIds: [], labels: [], powerValues: [] }
    if (!group.memberIds.includes(`${pin.refdes}.${pin.pinName}`)) group.memberIds.push(`${pin.refdes}.${pin.pinName}`)
    groupByRoot.set(root, group)
  }
  for (const [key, text] of labelByKey) {
    const root = uf.find(key)
    const group = groupByRoot.get(root) ?? { root, memberIds: [], labels: [], powerValues: [] }
    if (!group.labels.includes(text)) group.labels.push(text)
    groupByRoot.set(root, group)
  }
  for (const [key, value] of powerValueByKey) {
    const root = uf.find(key)
    const group = groupByRoot.get(root) ?? { root, memberIds: [], labels: [], powerValues: [] }
    if (!group.powerValues.includes(value)) group.powerValues.push(value)
    groupByRoot.set(root, group)
  }

  return { pins, pinById, groups: [...groupByRoot.values()], noConnectKeys }
}
