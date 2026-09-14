/**
 * Datasheet artifact contract (v2 "hybrid", docs/05 §8).
 *
 * Machine fields keep the v1 shape the runtime consumes (group list + pin list
 * + KiCad electrical type), and the v0.3 landscape artifacts supply the
 * provenance fields the anchor audit needs (`source_claims` per group, claim
 * ids on pins). Field names are snake_case, matching the v0.3 artifacts the
 * earlier pipeline produced.
 *
 * One entry = three files under `datasheet/<part_number>/`:
 *   index.json           groups (title/category/priority/brief/location/pins/claims)
 *   detail/<group_id>.json  one group's pins + notes + claim ids
 *   shape.json           the symbol shape block (docs/09 §5)
 *
 * Pin ownership rule: a physical pin number appears in AT MOST ONE group
 * (the runtime's pin universe rejects cross-group duplicates, and rejects gaps
 * or a non-1 start). Other groups carry claims and notes with no pins.
 */

/** One provenance claim extracted from the source document. */
export interface SourceClaim {
  claim_id: string
  /** `datasheet_text` (from `full.md`) or `web_search` (background evidence). */
  source_kind: string
  /** Locator inside the source, e.g. `full.md:15` or a URL. */
  source_ref: string
  section?: string
  extracted_fact: string
  verbatim_excerpt?: string
  confidence?: string
}

/** One external part a group's function requires (v3: the producer's value facts). */
export interface ExternalComponent {
  /** Kind as the datasheet states it: capacitor / resistor / crystal / diode / connector … */
  ref_kind: string
  /** Value as printed, e.g. `100 nF`, `10 kΩ`, `8 MHz`. */
  value: string
  /** How it connects, in the datasheet's words (which pin to which net, placement notes). */
  connection: string
  /** How many, when the datasheet states a count. */
  count?: number | string
  /** Why the datasheet requires it (the constraint, not a restatement of the value). */
  why?: string
  /** Claims of THIS group that state the requirement. */
  source_claim_ids?: string[]
}

/** One operating limit a group states (v3). */
export interface OperatingLimit {
  /** Parameter name as printed, e.g. `VDD`, `TA`, `fHSE`. */
  name: string
  /** Limit as printed, e.g. `2.0 to 3.6 V`. */
  value?: string
  /** Condition the limit holds under, when the datasheet states one. */
  condition?: string
  /** Claims of THIS group that state the limit. */
  source_claim_ids?: string[]
}

/** One function a pin can serve (v3: what the pin is FOR, not just its name). */
export interface PinFunction {
  /** Function name as printed, e.g. `USART1_TX`, `ADC_IN0`, `TIM2_CH1`. */
  name: string
  /** Role inside the design, when the datasheet or the intent states one. */
  role?: string
  /** Condition under which the pin serves this function, e.g. `remap`, `BOOT0=1`. */
  conditions?: string
}

/** One pin of one group. */
export interface DatasheetPin {
  /** Physical pin number as text; the endpoint token the tools use. */
  physical_number: string
  /** Pin name as printed in the datasheet (VDD, PA0, …). */
  canonical_name?: string
  /** KiCad electrical type: power_in / power_out / input / output / bidirectional / passive / … */
  electrical?: string
  aliases?: string[]
  /** Claim ids that support this pin, resolved inside the same group. */
  source_claim_ids?: string[]
  /** Functions this pin can serve (v3). */
  functions?: PinFunction[]
}

/** One group as summarised by `index.json`. */
export interface DatasheetGroup {
  group_id: string
  title: string
  /** overview / pinout / electrical / application / package / ordering / … */
  category?: string
  /** required / optional — whether the group is needed to draw the part. */
  priority?: string
  brief?: string
  /** What this group holds: its information, source section/table, constraint, when it is needed (v3, mandatory). */
  description?: string
  /** Prose design constraints stated for this group (v3). */
  design_notes?: string[]
  /** External parts this group's function requires, with values and connection (v3). */
  external_components?: ExternalComponent[]
  /** Operating limits this group states (v3). */
  operating_limits?: OperatingLimit[]
  /** Where the group came from in the source text. */
  location?: { line_start?: number; line_end?: number; search_signature?: string }
  /** Pins this group owns (empty for prose-only groups). */
  pins: DatasheetPin[]
  source_claims?: SourceClaim[]
}

/** `datasheet/<part>/index.json`. */
export interface DatasheetIndexFile {
  schema_version?: string
  part_number: string
  package?: string
  audited?: boolean
  modified_at?: number
  groups: DatasheetGroup[]
}

/** `datasheet/<part>/detail/<group_id>.json`. */
export interface DatasheetDetailFile {
  part_number?: string
  group_id: string
  title?: string
  pins: DatasheetPin[]
  notes?: string[]
  source_claim_ids?: string[]
  /** Group description, mirrored from the index (v3). */
  description?: string
  /** Prose design constraints, mirrored from the index group (v3). */
  design_notes?: string[]
  /** External parts with values and connection (v3). */
  external_components?: ExternalComponent[]
  /** Operating limits (v3). */
  operating_limits?: OperatingLimit[]
}

/** `datasheet/<part>/shape.json` (docs/09 §5; geometry is engine-deterministic). */
export interface ShapeBlock {
  name: string
  refPrefix?: string
  description?: string
  pins: readonly { number: string; name: string; electrical: string; side?: string }[]
}
