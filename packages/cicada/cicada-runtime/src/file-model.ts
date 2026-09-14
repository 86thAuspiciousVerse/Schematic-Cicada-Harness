/**
 * In-memory schematic model for one producer turn (9-impl §1.4 `file-model`).
 *
 * A `Model` owns the mutable parse tree (the turn-local working copy), the
 * derived semantic view, and the geometric connectivity graph. All pin
 * resolution and world-coordinate queries flow through here, reusing the
 * deriver's transform as the single coordinate authority.
 */

import type { CoordG, LibPinSpec, LibSymbolSpec, SchematicFile, SymbolItem } from '@deepseek-ai/dsh-cicada-format'
import { derive, deriveConnectivity, memberKey, pinWorld, type Connectivity, type SemanticModel } from '@deepseek-ai/dsh-cicada-deriver'
import { CicadaError } from './errors.ts'

/** One resolved pin reference plus its world coordinate. */
export interface ResolvedPin {
  refdes: string
  /** Canonical pin name (lib name when non-empty, else the physical number). */
  pinName: string
  physicalNumber: string
  world: CoordG
  /** The lib pin spec backing this reference. */
  libPin: LibPinSpec
}

/** Coordinate key with -0 normalization (AGENTS 铁律 4). */
export function gKey(p: CoordG): string {
  return `${p.x === 0 ? 0 : p.x},${p.y === 0 ? 0 : p.y}`
}

/** Split a `refdes.pin` token at the final dot. */
export function splitEndpoint(value: string): { refdes: string; pin: string } {
  const dot = value.lastIndexOf('.')
  if (dot <= 0 || dot === value.length - 1) {
    throw new CicadaError('endpoint_resolution_failed', `invalid endpoint "${value}": expected refdes.pin`)
  }
  return { refdes: value.slice(0, dot), pin: value.slice(dot + 1) }
}

/** Turn-local mutable model. */
export class Model {
  file: SchematicFile
  view: SemanticModel
  conn: Connectivity

  constructor(file: SchematicFile) {
    this.file = file
    this.view = derive(file)
    this.conn = deriveConnectivity(file)
  }

  /** Re-derive the semantic view and connectivity after in-memory mutation. */
  refreshView(): void {
    this.view = derive(this.file)
    this.conn = deriveConnectivity(this.file)
  }

  /** Look up a lib symbol by its full lib id. */
  libOf(libId: string): LibSymbolSpec | undefined {
    return this.file.libSymbols.find((entry) => entry.libId === libId)
  }

  /** Look up a symbol instance by refdes. */
  symbolByRefdes(refdes: string): SymbolItem | undefined {
    return this.file.symbols.find((symbol) => symbol.properties.Reference === refdes)
  }

  /** Every refdes currently on the sheet (instances only). */
  refdesSet(): Set<string> {
    return new Set(this.file.symbols.map((symbol) => symbol.properties.Reference ?? ''))
  }

  /**
   * Resolve a `refdes.pin` endpoint token to a world-coordinate pin.
   * The token may name a pin either by canonical name or by physical number.
   * @param value - `refdes.pin` token.
   * @returns the resolved pin.
   */
  resolvePin(value: string): ResolvedPin {
    const { refdes, pin } = splitEndpoint(value)
    const symbol = this.symbolByRefdes(refdes)
    if (symbol === undefined) {
      throw new CicadaError('unknown_refdes', `unknown component "${refdes}"`)
    }
    const lib = this.libOf(symbol.libId)
    if (lib === undefined) {
      // M1b0 排障助手：列出当前条目，区分"从未写入"与"lib_id 归一错配"（如 Device:R vs cicada:R）
      const available = this.file.libSymbols.map((entry) => entry.libId).join(', ')
      throw new CicadaError(
        'symbol_unsupported',
        `lib symbol "${symbol.libId}" is missing from lib_symbols (have: [${available}])`,
      )
    }
    const spec = lib.pins.find(
      (p) => (p.name !== '' && p.name !== '~' ? p.name : p.number) === pin || p.number === pin,
    )
    if (spec === undefined) {
      throw new CicadaError('unknown_pin', `unknown pin "${value}" on ${refdes} (lib ${symbol.libId})`)
    }
    const world = pinWorld(symbol.at, symbol.rotation, spec.at)
    return {
      refdes,
      pinName: spec.name !== '' && spec.name !== '~' ? spec.name : spec.number,
      physicalNumber: spec.number,
      world,
      libPin: spec,
    }
  }

  /** The member key of a resolved pin (matches `memberKey` vocabulary). */
  keyOf(pin: ResolvedPin): string {
    return memberKey({ refdes: pin.refdes, pinName: pin.pinName, physicalNumber: pin.physicalNumber })
  }

  /** World coordinate of an already-known member key, if the pin exists. */
  worldOfMember(key: string): CoordG | undefined {
    return this.conn.pinById.get(key)?.world
  }
}
