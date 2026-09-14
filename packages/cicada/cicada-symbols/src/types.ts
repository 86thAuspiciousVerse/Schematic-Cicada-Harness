/** Types only — no runtime code in this file. */

import type { CoordG, G } from '@deepseek-ai/dsh-cicada-format'

export type { CoordG, G } from '@deepseek-ai/dsh-cicada-format'

/** Side of a bounding box in screen coordinates (Y down). */
export type Side = 'top' | 'right' | 'bottom' | 'left'

/** A generated pin slot (library coordinate space, before Y negation at write time). */
export interface GeneratedPin {
  /** Physical pin number (`1`-based, ascending). */
  number: string
  /** Placement along the side in G units. */
  at: CoordG
  /** Pin direction angle in file semantics (points toward the body). */
  angle: number
  /** Pin length in G units (extends toward the body). */
  length: G
  /** Electrical type written into the file (`passive`, `power_in`, ...). */
  type: string
  /** Graphic shape (`line`, ...). */
  shape: string
}

/** Deterministic four-edge distribution result. */
export interface IcGeometry {
  perSide: number
  sides: Record<Side, number>
  /** Box width in G units (pins at the outer edges). */
  width: G
  /** Box height in G units. */
  height: G
}

/** One candidate pin observation from a datasheet group. */
export interface PinObservation {
  physicalNumber: string
}

/** Result of the pin-universe guard (E11, 4-spec §3.3). */
export interface PinUniverseResult {
  /** Unique pin universe keyed by physical number, first-wins. */
  pins: Map<string, PinObservation>
  /** True when every expected pin is present without duplicates. */
  complete: boolean
  /** Set when incomplete: 'pin_universe_incomplete' (duplicate/dubious entries also reject). */
  errorCode?: 'pin_universe_incomplete'
}

/** Template kinds supported at v1 (4-spec §3.3). */
export type TemplateKind = 'sym2' | 'polar2' | 'tri' | 'connector' | 'power'
