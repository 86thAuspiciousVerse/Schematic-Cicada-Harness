/** Types only — no runtime code in this file. */

/** Coordinate unit: 0.01mm integer (`mm = G / 100`, 0.01mm = 100 IU exactly). */
export type G = number

/** A coordinate in G units. */
export interface CoordG {
  x: G
  y: G
}

/** Symbol rotation on the sheet; mirror is unsupported. */
export type Rotation = 0 | 90 | 180 | 270

/** A quoted string leaf in the S-expression tree. */
export interface SexprStr {
  type: 'str'
  value: string
}

/** A bare atom leaf in the S-expression tree (keywords, numbers, uuids). */
export interface SexprAtom {
  type: 'atom'
  value: string
}

export type SexprLeaf = SexprStr | SexprAtom

/** An S-expression list node: `(head child child ...)`. */
export interface Sexpr {
  head: string
  children: SexprItem[]
}

export type SexprItem = Sexpr | SexprLeaf

/** A pin as defined in a library symbol (local coordinates, `at` is the connectable outer end). */
export interface LibPinSpec {
  /** Physical pin number as written (`(number "1")`). */
  number: string
  /** Pin name (`(name "...")`; may be empty for unnamed pins). */
  name: string
  /** Pin position in G units (library coordinate, Y already negated in file values). */
  at: CoordG
  /** Pin direction angle as written in `(at x y angle)`. */
  angle: number
  /** Pin length in G units. */
  length: G
  /** Electrical type (`passive`, `power_in`, ...). */
  type: string
  /** Graphic shape (`line`, ...). */
  shape: string
}

/** A library symbol definition parsed from `lib_symbols`. */
export interface LibSymbolSpec {
  /** Full lib id, e.g. `cicada:R`. */
  libId: string
  /** Lib item name after the `cicada:` prefix. */
  name: string
  /** True when the symbol carries the `(power)` marker. */
  power: boolean
  /** True when the symbol hides pin numbers. */
  pinNumbersHidden: boolean
  /** Pins of unit 1 (`<name>_1_1` body). */
  pins: LibPinSpec[]
  /** The raw S-expression node, re-emitted verbatim on serialize. */
  body: Sexpr
}

/** One symbol instance on the sheet. */
export interface SymbolItem {
  /** Referenced lib id, e.g. `cicada:R`. */
  libId: string
  /** Instance position in G units. */
  at: CoordG
  /** Instance rotation (0/90/180/270). */
  rotation: Rotation
  /** Instance unit; always 1 (multi-unit symbols are unsupported). */
  unit: number
  /** Instance uuid. */
  uuid: string
  /** Property values by canonical name (`Reference`, `Value`, `Footprint`, `Datasheet`, ...). */
  properties: Record<string, string>
  /** Explicit pin entries in file order: physical number -> uuid. */
  pins: { number: string; uuid: string }[]
}

/** A wire segment: exactly two endpoints in G units. */
export interface WireItem {
  pts: [CoordG, CoordG]
  uuid: string
}

/** A net label placed on the sheet. */
export interface LabelItem {
  text: string
  at: CoordG
  rotation: number
  uuid: string
}

/** A no-connect marker. */
export interface NoConnectItem {
  at: CoordG
  uuid: string
}

/** A junction marker (parsed but ignored for connectivity). */
export interface JunctionItem {
  at: CoordG
  uuid: string
}

/** Parsed schematic file model (truth or export copy, discriminated by `version`). */
export interface SchematicFile {
  version: number
  generator: string
  generatorVersion: string
  uuid: string
  /** Page size; omitted by the truth format (defaults to A4). */
  paper?: string
  /** Opaque `title_block` content preserved on re-emit. */
  titleBlock?: Sexpr
  libSymbols: LibSymbolSpec[]
  symbols: SymbolItem[]
  wires: WireItem[]
  labels: LabelItem[]
  junctions: JunctionItem[]
  noConnects: NoConnectItem[]
  /** True when the file carries the `sheet_instances` section. */
  hasSheetInstances: boolean
}

/** Error codes produced by parse/validate. */
export type FormatErrorCode =
  /** A top-level or token outside the whitelist was encountered (fail-closed). */
  | 'symbol_unsupported'
  /** The text is not a well-formed schematic S-expression. */
  | 'malformed'

/** Structural validation issue produced by `validate`. */
export interface ValidationIssue {
  code: string
  message: string
}

/** Result of `validate`. */
export interface ValidationResult {
  ok: boolean
  errors: ValidationIssue[]
}
