/** Types only — no runtime code in this file. */

import type { CoordG } from '@deepseek-ai/dsh-cicada-format'

export type { CoordG, G, Rotation, SchematicFile } from '@deepseek-ai/dsh-cicada-format'

/** One pin of a component, referenced by canonical name (refdes.pin). */
export interface ComponentPinRef {
  refdes: string
  /** Canonical pin name (empty for unnamed pins like R/C pin 1-2). */
  pinName: string
  /** Physical pin number as written in the file. */
  physicalNumber: string
}

/** One net member (a pin that belongs to the net). */
export interface NetMember extends ComponentPinRef {}

/** A derived net (labelled, power, or auto-numbered NETn). */
export interface Net {
  name: string
  members: NetMember[]
  /** True when the net is named by a label. */
  labelled: boolean
  /** True when the net is named by a power symbol's Value (global net). */
  power: boolean
}

/** One component in the semantic model (coordinate-free). */
export interface Component {
  refdes: string
  value: string
  libId: string
  /** Pins with their library canonical name (the physical number when unnamed). */
  pins: { number: string; name: string }[]
}

/** A pin marked no-connect. */
export interface NoConnectMember extends ComponentPinRef {}

/** Coordinate-free semantic model of the schematic (4-spec §4). */
export interface SemanticModel {
  components: Component[]
  nets: Net[]
  noConnects: NoConnectMember[]
  /** All label texts in the file. */
  labels: string[]
}

/** Connectivity invariants violation. */
export interface InvariantViolation {
  code: 'duplicate_refdes' | 'pin_multi_net' | 'no_connect_conflict'
  message: string
}

/** Effective pin on the sheet after transform (internal connectivity graph; not exported in the view). */
export interface WorldPin extends ComponentPinRef {
  world: CoordG
}
