/**
 * Parser: tokens -> generic S-expression tree -> typed {@link SchematicFile}.
 *
 * Fail-closed: any top-level token outside {@link TOP_WHITELIST} throws
 * `FormatError('symbol_unsupported', token)`; nothing is silently dropped.
 * Inside a symbol instance, `mirror` also throws (`mirror` changes the
 * transform and would silently corrupt connectivity); connectivity-neutral
 * KiCad optional fields (`in_bom`, `on_board`, `dnp`, `exclude_from_sim`,
 * `instances`, `fields_autoplaced`, `body_style`) are ignored.
 */

import { G_PER_MM, TOP_WHITELIST } from './constants.ts'
import { tokenize, type Token } from './tokenizer.ts'
import type {
  CoordG,
  FormatErrorCode,
  G,
  JunctionItem,
  LabelItem,
  LibPinSpec,
  LibSymbolSpec,
  NoConnectItem,
  Rotation,
  SchematicFile,
  Sexpr,
  SexprItem,
  SexprLeaf,
  SymbolItem,
  WireItem,
} from './types.ts'

/** Thrown on malformed text or an unsupported (whitelisted-out) token. */
export class FormatError extends Error {
  readonly code: FormatErrorCode
  constructor(code: FormatErrorCode, message: string) {
    super(message)
    this.name = 'FormatError'
    this.code = code
  }
}

/** Parse schematic text into a typed {@link SchematicFile}; fail-closed on unsupported tokens. */
export function parse(text: string): SchematicFile {
  const tokens = tokenize(text)
  const { node, next } = buildNode(tokens, 0)
  if (next !== tokens.length) throw new FormatError('malformed', 'trailing tokens after root expression')
  return parseRoot(node)
}

/** Parse arbitrary S-expression text into a generic tree (for netlists and other KiCad sexpr). */
export function parseSexpr(text: string): Sexpr {
  const tokens = tokenize(text)
  const { node, next } = buildNode(tokens, 0)
  if (next !== tokens.length) throw new FormatError('malformed', 'trailing tokens after root expression')
  return node
}

/** Parse a generic `(kicad_sch ...)` node into a typed model. */
export function parseRoot(node: Sexpr): SchematicFile {
  if (node.head !== 'kicad_sch') throw new FormatError('malformed', `expected kicad_sch root, got ${node.head}`)

  const file: SchematicFile = {
    version: 0,
    generator: '',
    generatorVersion: '',
    uuid: '',
    libSymbols: [],
    symbols: [],
    wires: [],
    labels: [],
    junctions: [],
    noConnects: [],
    hasSheetInstances: false,
  }
  let sawVersion = false

  for (const child of node.children) {
    if (!isSexpr(child)) {
      throw new FormatError('malformed', `unexpected leaf at top level: ${leafValue(child)}`)
    }
    const key = child.head
    switch (key) {
      case 'version':
        file.version = Number.parseInt(requiredLeaf(child, key).value, 10)
        sawVersion = true
        break
      case 'generator':
        file.generator = requiredLeaf(child, key).value
        break
      case 'generator_version':
        file.generatorVersion = requiredLeaf(child, key).value
        break
      case 'uuid':
        file.uuid = uuidLeaf(child)
        break
      case 'paper':
        file.paper = requiredLeaf(child, key).value
        break
      case 'title_block':
        file.titleBlock = child
        break
      case 'lib_symbols':
        parseLibSymbols(child, file)
        break
      case 'symbol':
        file.symbols.push(parseSymbolInstance(child))
        break
      case 'wire':
        file.wires.push(parseWire(child))
        break
      case 'label':
        file.labels.push(parseLabel(child))
        break
      case 'junction':
        file.junctions.push(parseJunction(child))
        break
      case 'no_connect':
        file.noConnects.push(parseNoConnect(child))
        break
      case 'sheet_instances':
        file.hasSheetInstances = true
        break
      default:
        // Fail-closed: bus/arc/text/net_chain/embedded_fonts and anything unknown.
        throw new FormatError('symbol_unsupported', `unsupported top-level token: ${key}`)
    }
  }

  if (!sawVersion) throw new FormatError('malformed', 'missing (version ...) field')
  return file
}

/** Build one S-expression node starting at `start`; returns the node and the next token index. */
function buildNode(tokens: Token[], start: number): { node: Sexpr; next: number } {
  const first = tokens[start]
  if (!first || first.type !== 'open') throw new FormatError('malformed', 'expected (')
  const children: SexprItem[] = []
  let i = start + 1
  for (;;) {
    const token = tokens[i]
    if (token === undefined) throw new FormatError('malformed', 'unexpected end of input (missing )')
    if (token.type === 'close') {
      i++
      break
    }
    if (token.type === 'open') {
      const inner = buildNode(tokens, i)
      children.push(inner.node)
      i = inner.next
    } else {
      children.push(token.type === 'str' ? { type: 'str', value: token.value } : { type: 'atom', value: token.value })
      i++
    }
  }
  const headLeaf = children[0]
  if (!headLeaf || !isLeaf(headLeaf)) throw new FormatError('malformed', 'list node without head leaf')
  if (headLeaf.type !== 'atom') throw new FormatError('malformed', 'list head must be a bare atom')
  return { node: { head: headLeaf.value, children: children.slice(1) }, next: i }
}

function isSexpr(item: SexprItem | undefined): item is Sexpr {
  return item !== undefined && !isLeaf(item)
}

function isLeaf(item: SexprItem | undefined): item is SexprLeaf {
  return item !== undefined && ((item as SexprLeaf).type === 'str' || (item as SexprLeaf).type === 'atom')
}

function leafValue(item: SexprItem | undefined): string {
  if (!item) return ''
  return isLeaf(item) ? item.value : `<${item.head}>`
}

/** Leaf value of a single-child node such as `(uuid X)` or `(version N)`. */
function requiredLeaf(node: Sexpr, key: string): { value: string } {
  const leaf = node.children[0]
  if (!leaf || !isLeaf(leaf) || node.children.length !== 1) {
    throw new FormatError('malformed', `expected single leaf in (${key} ...)`)
  }
  return { value: leaf.value }
}

/**
 * UUID leaf allowing the empty form `(uuid )` — the engine saveback (and this
 * package's writer) leave pin/instance uuids empty; an empty node means "no
 * id", not malformed (M1c; engine-side parse already tolerates it).
 */
function uuidLeaf(node: Sexpr): string {
  const leaf = node.children[0]
  if (!leaf || !isLeaf(leaf)) return ''
  return leaf.value
}

/** First child node with the given head, or undefined. */
function childNode(node: Sexpr, head: string): Sexpr | undefined {
  return node.children.find((c): c is Sexpr => isSexpr(c) && c.head === head)
}

/** All child nodes with the given head. */
function childNodes(node: Sexpr, head: string): Sexpr[] {
  return node.children.filter((c): c is Sexpr => isSexpr(c) && c.head === head)
}

function parseCoordList(node: Sexpr, key: string): CoordG {
  if (node.children.length < 2) throw new FormatError('malformed', `(${key} ...) needs two coordinates`)
  const x = leafValue(node.children[0])
  const y = leafValue(node.children[1])
  if (!isLeaf(node.children[0]) || !isLeaf(node.children[1])) {
    throw new FormatError('malformed', `(${key} ...) coordinates must be atoms`)
  }
  return { x: mmToG(x), y: mmToG(y) }
}

function mmToG(text: string): G {
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) throw new FormatError('malformed', `non-numeric coordinate: ${text}`)
  return Math.round(value * G_PER_MM)
}

function parseLibSymbols(node: Sexpr, file: SchematicFile): void {
  for (const child of childNodes(node, 'symbol')) {
    file.libSymbols.push(parseLibSymbol(child))
  }
}

function parseLibSymbol(node: Sexpr): LibSymbolSpec {
  const libLeaf = node.children[0]
  if (!libLeaf || !isLeaf(libLeaf) || node.children.length === 0) {
    throw new FormatError('malformed', 'library symbol without name string')
  }
  const libId = libLeaf.value
  // 库键模型（docs/09 §1）：libId 是 `category:name`（内置/精选/用户库）或旧的
  // `cicada:name` 前缀；子符号名只带 name（KiCad 亦如此，如 `C:C_Small` 的单元
  // 体是 `C_Small_1_1`）。取最后一个 ':' 之后的尾段，两套前缀同规则。
  const sep = libId.lastIndexOf(':')
  const name = sep >= 0 ? libId.slice(sep + 1) : libId
  const power = childNode(node, 'power') !== undefined
  const pinNumbers = childNode(node, 'pin_numbers')
  const pinNumbersHidden = pinNumbers !== undefined && pinNumbersHiddenValue(pinNumbers)
  const body = childNodes(node, 'symbol')
  const unit1 = body.find((b) => isSubSymbolNamed(b, name, 1))
  const pins: LibPinSpec[] = []
  if (unit1) {
    for (const pinNode of childNodes(unit1, 'pin')) pins.push(parseLibPin(pinNode))
  }
  return { libId, name, power, pinNumbersHidden, pins, body: node }
}

function pinNumbersHiddenValue(node: Sexpr): boolean {
  for (const child of node.children) {
    if (isLeaf(child)) {
      if (child.type === 'atom' && child.value === 'hide') return true
    } else if (child.head === 'hide') {
      const v = child.children[0]
      if (v && isLeaf(v) && v.value !== 'yes') return false
      return true
    }
  }
  return false
}

function isSubSymbolNamed(node: Sexpr, name: string, unit: number): boolean {
  const leaf = node.children[0]
  if (!leaf || !isLeaf(leaf)) return false
  return leaf.value === `${name}_${unit}_1` || leaf.value === `${name}_${unit}_0`
}

function parseLibPin(node: Sexpr): LibPinSpec {
  const typeLeaf = node.children[0]
  const shapeLeaf = node.children[1]
  if (!typeLeaf || !isLeaf(typeLeaf) || !shapeLeaf || !isLeaf(shapeLeaf)) {
    throw new FormatError('malformed', 'pin must start with <type> <shape> atoms')
  }
  const at = childNode(node, 'at')
  const length = childNode(node, 'length')
  const name = childNode(node, 'name')
  const number = childNode(node, 'number')
  const angleLeaf = at?.children[2]
  const angle = angleLeaf && isLeaf(angleLeaf) ? Number.parseInt(angleLeaf.value, 10) || 0 : 0
  const atCoord = at && at.children.length >= 2 ? parseCoordList(at, 'at') : { x: 0, y: 0 }
  return {
    number: nameOf(number),
    name: nameOf(name),
    at: atCoord,
    angle,
    length: length && isLeaf(length.children[0]) ? mmToG(length.children[0].value) : 0,
    type: typeLeaf.value,
    shape: shapeLeaf.value,
  }
}

function nameOf(node: Sexpr | undefined): string {
  if (!node) return ''
  const leaf = node.children[0]
  return leaf && isLeaf(leaf) ? leaf.value : ''
}

function parseSymbolInstance(node: Sexpr): SymbolItem {
  const libId = childNode(node, 'lib_id')
  const at = childNode(node, 'at')
  const unit = childNode(node, 'unit')
  const uuid = childNode(node, 'uuid')
  if (!libId) throw new FormatError('malformed', 'symbol instance without lib_id')
  const libLeaf = libId.children[0]
  if (!libLeaf || !isLeaf(libLeaf)) throw new FormatError('malformed', 'lib_id must be a string')

  const properties: Record<string, string> = {}
  for (const prop of childNodes(node, 'property')) {
    const nameLeaf = prop.children[0]
    const valueLeaf = prop.children[1]
    if (nameLeaf && isLeaf(nameLeaf) && valueLeaf && isLeaf(valueLeaf)) {
      properties[nameLeaf.value] = valueLeaf.value
    }
  }

  const pins: SymbolItem['pins'] = []
  for (const pin of childNodes(node, 'pin')) {
    const numberLeaf = pin.children[0]
    const pinUuid = childNode(pin, 'uuid')
    if (!numberLeaf || !isLeaf(numberLeaf)) continue
    pins.push({ number: numberLeaf.value, uuid: pinUuid ? uuidLeaf(pinUuid) : '' })
  }

  for (const child of node.children) {
    if (!isSexpr(child)) continue
    if (child.head === 'mirror') {
      // Mirror flips the transform; refusing is safer than silently deriving wrong connectivity.
      throw new FormatError('symbol_unsupported', 'mirror is not supported')
    }
  }

  const rotation = parseRotation(at)
  // Multi-unit devices are not supported (4-spec §3.2 / 8-spec §1.4):
  // refusing beats silently deriving wrong connectivity from unit 1 pins.
  const unitValue = unit ? Number.parseInt(leafValue(unit.children[0]), 10) : 1
  if (unitValue !== 1) {
    throw new FormatError('symbol_unsupported', `unit ${unitValue} is not supported`)
  }
  return {
    libId: libLeaf.value,
    at: rotation.at,
    rotation: rotation.rotation,
    unit: 1,
    uuid: uuid ? uuidLeaf(uuid) : '',
    properties,
    pins,
  }
}

function parseRotation(at: Sexpr | undefined): { at: CoordG; rotation: Rotation } {
  if (!at) return { at: { x: 0, y: 0 }, rotation: 0 }
  const raw = parseCoordList(at, 'at')
  const rotLeaf = at.children[2]
  const rot = rotLeaf && isLeaf(rotLeaf) ? Number.parseInt(rotLeaf.value, 10) : 0
  if (!([0, 90, 180, 270] as const).includes(rot as 0 | 90 | 180 | 270)) {
    // Rotation is a transform-affecting field (8-spec §1.4): a value outside
    // the whitelist must fail closed, exactly like mirror.
    throw new FormatError('symbol_unsupported', `rotation ${rot} is not supported`)
  }
  return { at: raw, rotation: rot as Rotation }
}

function parseWire(node: Sexpr): WireItem {
  const pts = childNode(node, 'pts')
  if (!pts) throw new FormatError('malformed', 'wire without pts')
  const coords = pts.children
    .filter((c): c is Sexpr => isSexpr(c) && c.head === 'xy')
    .map((xy) => parseCoordList(xy, 'xy'))
  const [p0, p1] = coords
  if (coords.length !== 2 || !p0 || !p1) throw new FormatError('malformed', 'wire pts must contain exactly two xy points')
  const uuid = childNode(node, 'uuid')
  return { pts: [p0, p1], uuid: uuid ? uuidLeaf(uuid) : '' }
}

function parseLabel(node: Sexpr): LabelItem {
  const textLeaf = node.children[0]
  if (!textLeaf || !isLeaf(textLeaf)) throw new FormatError('malformed', 'label without text string')
  const at = childNode(node, 'at')
  const uuid = childNode(node, 'uuid')
  const rot = at && isLeaf(at.children[2]) ? Number.parseInt(at.children[2].value, 10) : 0
  return {
    text: textLeaf.value,
    at: at ? parseCoordList(at, 'at') : { x: 0, y: 0 },
    rotation: rot,
    uuid: uuid ? uuidLeaf(uuid) : '',
  }
}

function parseNoConnect(node: Sexpr): NoConnectItem {
  const at = childNode(node, 'at')
  const uuid = childNode(node, 'uuid')
  return {
    at: at ? parseCoordList(at, 'at') : { x: 0, y: 0 },
    uuid: uuid ? uuidLeaf(uuid) : '',
  }
}

function parseJunction(node: Sexpr): JunctionItem {
  const at = childNode(node, 'at')
  const uuid = childNode(node, 'uuid')
  return {
    at: at ? parseCoordList(at, 'at') : { x: 0, y: 0 },
    uuid: uuid ? uuidLeaf(uuid) : '',
  }
}
