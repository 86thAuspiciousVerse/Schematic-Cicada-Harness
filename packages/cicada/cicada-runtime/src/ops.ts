/**
 * The eight write operations, purely on the in-memory {@link Model} (8-spec
 * §2–§9). Each op mutates the model's parse tree, refreshes the semantic view,
 * and returns the tool-level result; failures throw {@link CicadaError} and
 * leave the model untouched (transaction rollback is the caller's clone).
 */

import type { CoordG, LibSymbolSpec, SchematicFile, SymbolItem } from '@deepseek-ai/dsh-cicada-format'
import { memberKey, pinWorld } from '@deepseek-ai/dsh-cicada-deriver'
import { buildTemplate, electricalToEngine, pinUniverse, sideToEngine, type TemplateKind } from '@deepseek-ai/dsh-cicada-symbols'
import { randomUUID } from 'node:crypto'

import { CicadaError } from './errors.ts'
import { gKey, Model } from './file-model.ts'
import { icLibText, libEntryText, libSpecFromText } from './libbuild.ts'
import { bboxOf, GAP_G, nextPlacement } from './layout.ts'

// ── shared types ────────────────────────────────────────────────────────────

/** Read side of the datasheet pin universe (workspace `datasheet/<part>/`). */
export interface DatasheetPinSource {
  part_number: string
  groups: readonly (readonly { physicalNumber: string; name?: string; type?: string }[])[]
  expected: number
}

/** Ops dependencies injected by the runtime host. */
export interface OpHost {
  /** Retrieve a datasheet pin universe for `part_number`, or undefined when absent. */
  datasheet?: (part: string) => DatasheetPinSource | undefined
  /** Engine-backed symbol geometry lookup (M1b 库道); undefined = library lane unavailable. */
  lib?: {
    get: (name: string) => LibSymbolGeometry | undefined
    /** All loaded symbol names (for error hints). */
    list: () => string[]
    /** M1e-1: 形状块 → 引擎 /lib/synthesize（用户库 + 确定性几何）；缺省 = 引擎不可合成。 */
    synthesize?: (block: DatasheetShapeBlock) => Promise<{ ok: boolean; libId?: string; warnings?: string[]; error?: string }>
  }
}

/** Engine-backed library symbol geometry (G units; pins carry exact at/angle). */
export interface LibSymbolGeometry {
  /** Canonical library key from the engine (`category:name`; docs/09 §1). */
  libId: string
  name: string
  pins: readonly { number: string; name: string; x: number; y: number; angle: number }[]
}

/** M1e-1 shape block (semantics only; geometry is engine-deterministic, docs/02 附录 A). */
export interface DatasheetShapeBlock {
  name: string
  refPrefix?: string
  description?: string
  pins: readonly { number: string; name: string; electrical: string; side?: string }[]
}

export interface PlaceSymbolArgs {
  refdes: string
  value: string
  /** Datasheet lane: exact part number (mutually exclusive with `kind`). */
  part_number?: string
  /** Datasheet lane: package text (Footprint). */
  package?: string
  /** Datasheet lane: source detail group ids (v1 presence-only). */
  source_ids?: string[]
  /** Template lane: one of `sym2 | polar2 | tri | connector | power`. */
  kind?: string
  /** Template lane: Footprint text. */
  footprint?: string
  /** M1b 库道: full lib key `category:name` (e.g. "R:R", "IC:AMS1117") from the catalog. */
  lib_id?: string
}

export interface PlaceSymbolResult {
  refdes: string
  lib_id: string
  pin_table: Record<string, { canonical_name: string; x_mm: number; y_mm: number; electrical: string }>
}

export interface ConnectPinsArgs {
  /** Endpoint pairs `[[a,b], ...]`; chained order is preserved. */
  endpoints: string[][]
  /** Optional label placed at the first endpoint of the first pair. */
  net_name?: string
  source_ids?: string[]
}

export interface ConnectPinsResult {
  nets: { name: string; members: string[] }[]
  wires: { a: string; b: string; path: CoordG[] }[]
}

export interface PlaceLabelArgs {
  name: string
  endpoint: string
}

export interface PlacePowerArgs {
  name: string
  endpoint: string
}

export interface SimpleResult {
  ok: true
  message: string
}

export interface DisconnectArgs {
  endpoint: string
  expected_net: string
}

export interface SetPropertyArgs {
  refdes: string
  property: 'Reference' | 'Value' | 'Footprint'
  value: string
}

export interface RemoveComponentArgs {
  refdes: string
}

export interface NetsResult {
  nets: string[]
}

const TEMPLATE_KINDS: readonly TemplateKind[] = ['sym2', 'polar2', 'tri', 'connector', 'power']
const PROPERTY_NAMES = ['Reference', 'Value', 'Footprint'] as const

function worldOf(symbol: SymbolItem, libAt: CoordG): CoordG {
  // Single coordinate authority (AGENTS 铁律 3): the deriver's transform.
  return pinWorld(symbol.at, symbol.rotation, libAt)
}

function canonicalName(pin: { name: string; number: string }): string {
  return pin.name !== '' && pin.name !== '~' ? pin.name : pin.number
}

/**
 * Is one `source_ids` entry a datasheet-lane anchor?
 *
 * Both spellings are accepted: the canonical `detail/<group_id>.json` and the
 * bare `<group_id>` — the producer reads group ids from
 * `datasheet_workspace_read_group(part, group_id)` and naturally passes that id
 * back (measured 2026-09-13: a bare `pinout` fell through to the template lane
 * and produced the useless error `unknown template kind ""`).
 * @param id - one source id from the tool call.
 * @returns true when it anchors the datasheet lane.
 */
export function isDetailAnchor(id: string): boolean {
  return /^detail\/[^/]+\.json$/.test(id) || /^[A-Za-z0-9_-]+$/.test(id)
}

/**
 * Normalize one shape block to the engine's vocabulary before `/lib/synthesize`.
 *
 * Only the two vocabularies we own are mapped (electrical, side); every other
 * field passes through untouched so the engine keeps judging the geometry.
 * @param block - shape block as authored in the workspace.
 * @returns a block whose pin vocabulary the engine accepts.
 */
export function toEngineBlock(block: DatasheetShapeBlock): DatasheetShapeBlock {
  return {
    ...block,
    pins: block.pins.map((pin) => {
      const side = sideToEngine(pin.side)
      return {
        number: String(pin.number ?? ''),
        name: String(pin.name ?? ''),
        electrical: electricalToEngine(pin.electrical),
        ...(side === undefined ? {} : { side }),
      }
    }),
  }
}

/** Key tail: `category:name` / `cicada:name` → `name` (docs/09 §1). */
export function tailOf(key: string): string {
  const sep = key.lastIndexOf(':')
  return sep >= 0 ? key.slice(sep + 1) : key
}

function netNameOf(model: Model, key: string): string | undefined {
  return model.view.nets.find((net) => net.members.some((member) => memberKey(member) === key))?.name
}

// ── place_symbol ────────────────────────────────────────────────────────────

export function placeSymbol(model: Model, args: PlaceSymbolArgs, host: OpHost): PlaceSymbolResult {
  if (model.refdesSet().has(args.refdes)) {
    throw new CicadaError('duplicate_refdes', `refdes "${args.refdes}" already exists`)
  }
  const datasheetLane = (args.source_ids ?? []).some(isDetailAnchor)
  const entry = ensureLibEntry(model, args, host, datasheetLane)
  const boxes = model.file.symbols.map((symbol) => {
    const lib = model.libOf(symbol.libId)
    return lib === undefined ? { w: 0, h: 0 } : bboxOf(lib)
  })
  // 占用避让（P0-b）：候选格压到已有符号的占地盒、或压到导线/标签/NC 标记的坐标就顺延。
  // 纯几何判定、不认型号——把"放上去才发现要绕线/要删了重画"提前挡掉。
  const half = (value: number): number => Math.max(Math.round(value / 2), GAP_G)
  const isFree = (slot: CoordG, box: { w: number; h: number }): boolean => {
    const left = slot.x - half(box.w)
    const right = slot.x + half(box.w)
    const top = slot.y - half(box.h)
    const bottom = slot.y + half(box.h)
    const inside = (x: number, y: number): boolean => x >= left && x <= right && y >= top && y <= bottom
    for (let index = 0; index < model.file.symbols.length; index += 1) {
      const other = model.file.symbols[index]
      if (other === undefined) continue
      const otherBox = boxes[index] ?? { w: 0, h: 0 }
      if (left <= other.at.x + half(otherBox.w) && right >= other.at.x - half(otherBox.w)
        && top <= other.at.y + half(otherBox.h) && bottom >= other.at.y - half(otherBox.h)) return false
    }
    for (const wire of model.file.wires) {
      for (const point of wire.pts) if (inside(point.x, point.y)) return false
    }
    for (const label of model.file.labels) if (inside(label.at.x, label.at.y)) return false
    for (const nc of model.file.noConnects) if (inside(nc.at.x, nc.at.y)) return false
    return true
  }
  const at = nextPlacement(boxes, isFree)
  const symbol: SymbolItem = {
    libId: entry.libId,
    at,
    rotation: 0,
    unit: 1,
    uuid: randomUUID(),
    properties: {
      Reference: args.refdes,
      Value: args.value,
      Footprint: datasheetLane ? (args.package ?? '') : (args.footprint ?? ''),
      Datasheet: datasheetLane ? (args.part_number ?? '') : '',
    },
    pins: entry.pins.map((pin) => ({ number: pin.number, uuid: randomUUID() })),
  }
  model.file.symbols.push(symbol)
  model.refreshView()
  return { refdes: args.refdes, lib_id: entry.libId, pin_table: pinTable(model, symbol) }
}

/** Ensure the lib entry exists once; returns the entry (new or reused). */
function ensureLibEntry(model: Model, args: PlaceSymbolArgs, host: OpHost, datasheetLane: boolean): LibSymbolSpec {
  if (args.lib_id !== undefined) {
    // M1b 库道：按库键（`category:name`）从引擎装载的库选择（几何 = 引擎真值；
    // 条目键 = 引擎返回的规范键，与文件/引擎投影同规则）。
    const literal = model.libOf(args.lib_id)
    if (literal !== undefined) return literal
    if (host.lib === undefined) {
      throw new CicadaError(
        'symbol_unsupported',
        'library lane unavailable (no engine client); use kind or part_number',
      )
    }
    const name = tailOf(args.lib_id)
    const geometry = host.lib.get(name)
    if (geometry === undefined) {
      const available = host.lib.list().join(', ')
      throw new CicadaError(
        'symbol_unsupported',
        `symbol "${name}" is not in the loaded library (have: [${available}])`,
      )
    }
    const existing = model.libOf(geometry.libId)
    if (existing !== undefined) return existing
    const entry = libSpecFromText(libEntryText(geometry.libId, geometry.pins), {})
    model.file.libSymbols.push(entry)
    return entry
  }
  if (datasheetLane) {
    if (args.part_number === undefined || args.part_number === '') {
      throw new CicadaError('datasheet_missing', 'datasheet lane requires an exact part_number')
    }
    return ensureIcEntry(model, args.part_number, host)
  }
  if (args.kind === undefined || !TEMPLATE_KINDS.includes(args.kind as TemplateKind)) {
    // Name the whole contract: the old message (`unknown template kind ""`) left
    // the caller with nothing to act on when it had passed `part_number` with a
    // source id the datasheet lane did not recognize.
    throw new CicadaError(
      'symbol_unsupported',
      'cannot resolve this placement — pass lib_id (library lane), kind (template lane), or '
      + `part_number + source_ids (datasheet lane; group ids like "pinout" or "detail/pinout.json"). `
      + `Got: lib_id=${args.lib_id ?? '-'} kind=${args.kind ?? '-'} part_number=${args.part_number ?? '-'} `
      + `source_ids=[${(args.source_ids ?? []).join(', ')}]`,
    )
  }
  const name = args.refdes.replace(/\d+$/, '')
  const libId = `cicada:${name}`
  const existing = model.libOf(libId)
  if (existing !== undefined) return existing
  const kind = args.kind as TemplateKind
  const template = buildTemplate(kind, name)
  const entry = libSpecFromText(template.text, {
    power: kind === 'power',
    pinNumbersHidden: template.text.includes('(hide yes)'),
  })
  model.file.libSymbols.push(entry)
  return entry
}

/** M1e-1: datasheet 知识 → 形状块（AI 语义；坐标由引擎 /lib/synthesize 确定性生成）。 */
export function datasheetShapeBlock(part: string, source: DatasheetPinSource): DatasheetShapeBlock {
  const universe = pinUniverse(
    source.groups.map((group) => group.map((pin) => ({ physicalNumber: pin.physicalNumber }))),
    source.expected,
  )
  if (!universe.complete) {
    throw new CicadaError('pin_universe_incomplete', `pin universe for "${part}" is incomplete (expected ${source.expected})`)
  }
  const byNumber = new Map<string, { name: string; type: string }>()
  for (const group of source.groups) {
    for (const pin of group) byNumber.set(pin.physicalNumber, { name: pin.name ?? '', type: electricalToEngine(pin.type) })
  }
  const pins = [...byNumber.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .map((number) => ({
      number,
      name: byNumber.get(number)?.name ?? '',
      electrical: byNumber.get(number)?.type ?? 'passive',
    }))
  if (pins.length === 0) throw new CicadaError('pin_universe_incomplete', `pin universe for "${part}" is empty`)
  return { name: part, refPrefix: 'U', description: '', pins }
}

function ensureIcEntry(model: Model, part: string, host: OpHost): LibSymbolSpec {
  const libId = `IC:${part}`
  const existing = model.libOf(libId)
  if (existing !== undefined) return existing
  const source = host.datasheet?.(part)
  if (source === undefined) throw new CicadaError('datasheet_missing', `no datasheet knowledge for "${part}"`)
  const block = datasheetShapeBlock(part, source)
  const pins = block.pins.map((pin) => ({ number: pin.number, name: pin.name, type: pin.electrical }))
  const entry = libSpecFromText(icLibText(libId, pins), { pinNumbersHidden: false })
  model.file.libSymbols.push(entry)
  return entry
}

function pinTable(model: Model, symbol: SymbolItem): PlaceSymbolResult['pin_table'] {
  const lib = model.libOf(symbol.libId)
  const table: PlaceSymbolResult['pin_table'] = {}
  if (lib === undefined) return table
  for (const pin of lib.pins) {
    const world = worldOf(symbol, pin.at)
    table[pin.number] = {
      canonical_name: canonicalName(pin),
      x_mm: world.x / 100,
      y_mm: world.y / 100,
      electrical: pin.type,
    }
  }
  return table
}

// ── connect_pins ────────────────────────────────────────────────────────────

export function connectPins(model: Model, args: ConnectPinsArgs): ConnectPinsResult {
  if (args.endpoints.length < 1) throw new CicadaError('too_few_endpoints', 'endpoints must not be empty')
  const resolved: { key: string; pin: ReturnType<Model['resolvePin']> }[] = []
  for (const pair of args.endpoints) {
    if (pair.length !== 2) throw new CicadaError('endpoint_resolution_failed', 'each endpoint pair must be [a, b]')
    const a = model.resolvePin(pair[0] as string)
    const b = model.resolvePin(pair[1] as string)
    // Duplicate check is PAIR-level (8-spec §3.7 chaining reuses a shared
    // endpoint across pairs: [[a,b],[b,c]] is legal).
    if (model.keyOf(a) === model.keyOf(b)) {
      throw new CicadaError('duplicate_endpoint', `endpoint "${model.keyOf(a)}" appears twice in one pair`)
    }
    resolved.push({ key: model.keyOf(a), pin: a }, { key: model.keyOf(b), pin: b })
  }
  assertNoCrossNetwork(model, resolved.map((entry) => entry.pin))
  const wires: ConnectPinsResult['wires'] = []
  for (let i = 0; i < args.endpoints.length; i += 1) {
    const pair = args.endpoints[i] as string[]
    const a = model.resolvePin(pair[0] as string)
    const b = model.resolvePin(pair[1] as string)
    const netA = netNameOf(model, model.keyOf(a))
    const netB = netNameOf(model, model.keyOf(b))
    if (netA !== undefined && netB !== undefined && netA === netB) {
      throw new CicadaError('connected_endpoint', `"${a.refdes}.${a.pinName}" and "${b.refdes}.${b.pinName}" are already connected on "${netA}"`)
    }
    const insideWire = (p: CoordG): boolean =>
      model.file.wires.some((wire) => strictlyInside(p, wire.pts))
    const junctions = [a.world, b.world].filter((point) => insideWire(point))
    const path = route(model, a.world, b.world)
    for (let s = 0; s < path.length - 1; s += 1) {
      const from = path[s] as CoordG
      const to = path[s + 1] as CoordG
      if (gKey(from) === gKey(to)) continue
      model.file.wires.push({ pts: [from, to], uuid: randomUUID() })
    }
    // T 型端点补 junction（同坐标只落一个；已有标记不重复）。
    for (const point of junctions) {
      const key = gKey(point)
      if (model.file.junctions.some((junction) => gKey(junction.at) === key)) continue
      model.file.junctions.push({ at: point, uuid: randomUUID() })
    }
    wires.push({ a: model.keyOf(a), b: model.keyOf(b), path })
  }
  if (args.net_name !== undefined && args.net_name !== '') {
    const first = resolved[0]?.pin
    if (first !== undefined) placeLabel(model, { name: args.net_name, endpoint: `${first.refdes}.${first.pinName}` })
  } else {
    model.refreshView()
  }
  const involved = new Set(resolved.map((entry) => entry.key))
  const nets = model.view.nets
    .filter((net) => net.members.some((member) => involved.has(memberKey(member))))
    .map((net) => ({ name: net.name, members: net.members.map(memberKey) }))
  return { nets, wires }
}

/** Every occupied world coordinate other than the endpoints at issue: pins, labels, NC markers. */
function collectObstacles(model: Model): Set<string> {
  const occupied = new Set<string>()
  for (const symbol of model.file.symbols) {
    const lib = model.libOf(symbol.libId)
    if (lib === undefined) continue
    for (const libPin of lib.pins) occupied.add(gKey(worldOf(symbol, libPin.at)))
  }
  for (const label of model.file.labels) occupied.add(gKey(label.at))
  for (const nc of model.file.noConnects) occupied.add(gKey(nc.at))
  return occupied
}

/** Precondition ② (E21-A2): a resolving endpoint must not coincide with another net's pin or label anchor. */
function assertNoCrossNetwork(model: Model, pins: ReturnType<Model['resolvePin']>[]): void {
  const occupied = collectObstacles(model)
  for (const pin of pins) {
    const point = gKey(pin.world)
    if (!occupied.has(point)) continue
    const mine = netNameOf(model, model.keyOf(pin))
    // Another pin at the same coordinate with a different net membership.
    for (const [otherKey, otherPin] of model.conn.pinById) {
      if (otherKey === model.keyOf(pin) || gKey(otherPin.world) !== point) continue
      const theirs = netNameOf(model, otherKey)
      if (theirs !== undefined && theirs !== mine) {
        throw new CicadaError('cross_network_conflict', `"${point}" is occupied by another net ("${theirs}")`)
      }
    }
    // A label anchor at the same coordinate belonging to a different net.
    for (const label of model.file.labels) {
      if (gKey(label.at) !== point) continue
      const labelNet = model.view.nets.find((net) => net.labelled && net.name === label.text)
      if (labelNet !== undefined && labelNet.name !== mine) {
        throw new CicadaError('cross_network_conflict', `"${point}" carries label "${label.text}" of another net`)
      }
    }
  }
}

// ── routing (8-spec §3.2) ───────────────────────────────────────────────────

const DETOUR_S = 254

/**
 * Deterministic wire path between two pin endpoints. Attempts, in priority
 * order: L horizontal-first, J (−S), J (+S), L vertical-first, JV (+S), JV (−S),
 * Z (+S), Z (−S); corners must avoid occupied coordinates and existing wire
 * interiors; an unmovable endpoint on an occupied or interior position fails
 * with `path_not_found` (8-spec §3.2, avoidance ①③).
 */
function route(model: Model, a: CoordG, b: CoordG): CoordG[] {
  if (gKey(a) === gKey(b)) throw new CicadaError('duplicate_endpoint', 'endpoints coincide')
  const occupied = collectObstacles(model)
  const blocked = (p: CoordG): boolean => {
    const key = gKey(p)
    return occupied.has(key) && key !== gKey(a) && key !== gKey(b)
  }
  const onExistingInterior = (p: CoordG): boolean =>
    model.file.wires.some((wire) => strictlyInside(p, wire.pts))
  // 端点落在已有导线**内部** = 电气上的 T 型连接（KiCad 里"把电源符号丢到导线上"就是这种）。
  // 2026-09-13 实测：以前这里直接抛错、且八件写工具没有加 junction 的能力，producer 只能反复
  // remove_component 重画（一次跑出 1089 次调用、31 次同一个错误而不收敛）。现在按 KiCad 语义
  // 落一个 junction 标记（engine 解析、write.ts 落盘、连接性仍按坐标判定）。
  const cornerFree = (points: readonly CoordG[]): boolean =>
    points.slice(1, -1).every((p) => !blocked(p) && !onExistingInterior(p))
  // 三档绕行距离（1S/2S/3S）：实测（2026-09-13）只有 1S 时稍微拥挤的图就报"绕线候选耗尽"，
  // 而 producer 没有更聪明的回退 → 白白丢掉一次连接机会。
  const candidates: CoordG[][] = [
    [a, { x: b.x, y: a.y }, b],
    [a, { x: a.x, y: b.y }, b],
  ]
  for (const s of [DETOUR_S, DETOUR_S * 2, DETOUR_S * 3]) {
    candidates.push(
      [a, { x: b.x - s, y: a.y }, { x: b.x - s, y: b.y }, b],
      [a, { x: b.x + s, y: a.y }, { x: b.x + s, y: b.y }, b],
      [a, { x: a.x, y: b.y + s }, { x: b.x, y: b.y + s }, b],
      [a, { x: a.x, y: b.y - s }, { x: b.x, y: b.y - s }, b],
      [a, { x: a.x + s, y: a.y }, { x: a.x + s, y: b.y }, b],
      [a, { x: a.x - s, y: a.y }, { x: a.x - s, y: b.y }, b],
    )
  }
  for (const candidate of candidates) {
    if (cornerFree(candidate)) return candidate
  }
  throw new CicadaError('path_not_found', `no free wire path from (${a.x},${a.y}) to (${b.x},${b.y}) after collision avoidance: every detour up to ${String(DETOUR_S * 3)} G is blocked. Open a corridor (move a wire or component), or split the connection into two connect_pins calls through an intermediate point you pick.`)
}

/** Strictly inside a wire segment (not an endpoint). */
function strictlyInside(p: CoordG, pts: readonly [CoordG, CoordG]): boolean {
  const a = pts[0]
  const b = pts[1]
  if (a === undefined || b === undefined) return false
  if (gKey(p) === gKey(a) || gKey(p) === gKey(b)) return false
  if (a.x === b.x) return p.x === a.x && Math.min(a.y, b.y) < p.y && p.y < Math.max(a.y, b.y)
  if (a.y === b.y) return p.y === a.y && Math.min(a.x, b.x) < p.x && p.x < Math.max(a.x, b.x)
  return false
}

// ── place_label ─────────────────────────────────────────────────────────────

export function placeLabel(model: Model, args: PlaceLabelArgs): { net: { name: string; members: string[] } } {
  const pin = model.resolvePin(args.endpoint)
  const key = model.keyOf(pin)
  // 同名 label = 按名连接（2026-09-13 改，见 docs/05 §8）：KiCad 的标准做法，deriver 本就按
  // label 文本合并网络（`connect.ts` 的 "label-text joining"）。旧规则禁止第二处同名 label，
  // 实测把唯一一条"按名连接"通道堵死 → producer 只能拉长线、甚至把晶振悬空。
  // 仍然拦住**意外合并**：把一个已经有别的名字的网络改标成新名字。
  const existingName = model.view.nets
    .filter((net) => net.members.some((member) => memberKey(member) === key))
    .map((net) => net.name)
    .find((name) => name !== undefined && name !== args.name)
  if (existingName !== undefined) {
    throw new CicadaError('duplicate_net_name', `"${key}" is already on net "${existingName}"; labelling it "${args.name}" would merge two differently named nets. Label it "${existingName}" to join that net, or pick a point that is not on a named net.`)
  }
  const nets = model.view.nets.filter((net) => net.members.some((member) => memberKey(member) === key))
  if (nets.length > 1) throw new CicadaError('endpoint_in_multiple_nets', `"${key}" spans multiple nets`)
  if (model.file.noConnects.some((nc) => gKey(nc.at) === gKey(pin.world))) {
    throw new CicadaError('no_connect_conflict', `"${key}" already carries a no-connect marker`)
  }
  if (!model.file.labels.some((label) => label.text === args.name && gKey(label.at) === gKey(pin.world))) {
    model.file.labels.push({ text: args.name, at: pin.world, rotation: 0, uuid: randomUUID() })
  }
  model.refreshView()
  const net = model.view.nets.find((candidate) => candidate.name === args.name)
  return { net: { name: args.name, members: net?.members.map(memberKey) ?? [key] } }
}

// ── place_power_symbol ──────────────────────────────────────────────────────

export function placePowerSymbol(model: Model, args: PlacePowerArgs): { net: { name: string; members: string[] } } {
  const pin = model.resolvePin(args.endpoint)
  const name = args.name
  const libId = `cicada:${name}`
  if (model.libOf(libId) === undefined) {
    const template = buildTemplate('power', name)
    model.file.libSymbols.push(libSpecFromText(template.text, { power: true, pinNumbersHidden: true }))
  }
  const existing = model.file.symbols.filter((symbol) => (symbol.properties.Reference ?? '').startsWith('#PWR'))
  const refdes = `#PWR${String(existing.length + 1).padStart(2, '0')}`
  const symbol: SymbolItem = {
    libId,
    at: pin.world,
    rotation: 0,
    unit: 1,
    uuid: randomUUID(),
    properties: { Reference: refdes, Value: name, Footprint: '', Datasheet: '' },
    pins: [{ number: '1', uuid: randomUUID() }],
  }
  model.file.symbols.push(symbol)
  model.refreshView()
  const net = model.view.nets.find((candidate) => candidate.name === name)
  return { net: { name, members: net?.members.map(memberKey) ?? [model.keyOf(pin)] } }
}

// ── place_no_connect ────────────────────────────────────────────────────────

export function placeNoConnect(model: Model, args: { endpoint: string; nc_kind?: string }): SimpleResult {
  const pin = model.resolvePin(args.endpoint)
  const point = gKey(pin.world)
  if (model.file.noConnects.some((nc) => gKey(nc.at) === point)) {
    throw new CicadaError('no_connect_conflict', `"${model.keyOf(pin)}" already has a no-connect marker`)
  }
  if (model.file.labels.some((label) => gKey(label.at) === point)) {
    throw new CicadaError('no_connect_conflict', `"${model.keyOf(pin)}" carries a label`)
  }
  if (netNameOf(model, model.keyOf(pin)) !== undefined) {
    throw new CicadaError('connected_endpoint', `"${model.keyOf(pin)}" is connected to a net`)
  }
  model.file.noConnects.push({ at: pin.world, uuid: randomUUID() })
  model.refreshView()
  return { ok: true, message: `已对 ${model.keyOf(pin)} 放置未连接标记。` }
}

// ── disconnect (CAS on the in-memory view; 8-spec §7) ───────────────────────

export function disconnect(model: Model, args: DisconnectArgs): NetsResult {
  const pin = model.resolvePin(args.endpoint)
  const key = model.keyOf(pin)
  const current = netNameOf(model, key)
  if (current === undefined) throw new CicadaError('endpoint_not_connected', `"${key}" is not connected`)
  if (current !== args.expected_net) {
    throw new CicadaError('expected_net_mismatch', `"${key}" is now on "${current}", expected "${args.expected_net}"`)
  }
  const point = gKey(pin.world)
  model.file.wires = model.file.wires.filter((wire) => gKey(wire.pts[0]) !== point && gKey(wire.pts[1]) !== point)
  model.refreshView()
  return { nets: [current] }
}

// ── set_property ────────────────────────────────────────────────────────────

export function setProperty(model: Model, args: SetPropertyArgs): SimpleResult {
  if (!PROPERTY_NAMES.includes(args.property)) {
    throw new CicadaError('symbol_unsupported', `unknown property "${args.property}"`)
  }
  const symbol = model.symbolByRefdes(args.refdes)
  if (symbol === undefined) {
    throw new CicadaError('unknown_refdes', `unknown component "${args.refdes}"`)
  }
  if (args.property === 'Reference') {
    if (args.value !== args.refdes && model.refdesSet().has(args.value)) {
      throw new CicadaError('duplicate_refdes', `refdes "${args.value}" already exists`)
    }
    symbol.properties.Reference = args.value
  } else if (args.property === 'Value') {
    const lib = model.libOf(symbol.libId)
    if (lib?.power === true) {
      const clash = model.file.symbols.find((other) => other !== symbol && other.properties.Value === args.value)
      if (clash !== undefined) throw new CicadaError('duplicate_net_name', `net name "${args.value}" already exists`)
    }
    symbol.properties.Value = args.value
  } else {
    symbol.properties.Footprint = args.value
  }
  model.refreshView()
  return { ok: true, message: `已将 ${args.refdes} 的 ${args.property} 改为 ${args.value}。` }
}

// ── remove_component ────────────────────────────────────────────────────────

export function removeComponent(model: Model, args: RemoveComponentArgs): NetsResult & { removed: string[] } {
  const symbol = model.symbolByRefdes(args.refdes)
  if (symbol === undefined) throw new CicadaError('unknown_refdes', `unknown component "${args.refdes}"`)
  const lib = model.libOf(symbol.libId)
  if (lib === undefined) throw new CicadaError('symbol_unsupported', `lib symbol "${symbol.libId}" is missing`)
  const removedPoints = new Set(lib.pins.map((pin) => gKey(worldOf(symbol, pin.at))))
  const affected = model.view.nets
    .filter((net) => net.members.some((member) => member.refdes === args.refdes))
    .map((net) => net.name)
  model.file.symbols = model.file.symbols.filter((candidate) => candidate !== symbol)
  model.file.labels = model.file.labels.filter((label) => !removedPoints.has(gKey(label.at)))
  model.file.noConnects = model.file.noConnects.filter((nc) => !removedPoints.has(gKey(nc.at)))
  model.refreshView()
  const safe = new Set<string>()
  for (const survivor of model.file.symbols) {
    const survivorLib = model.libOf(survivor.libId)
    if (survivorLib === undefined) continue
    for (const pin of survivorLib.pins) safe.add(gKey(worldOf(survivor, pin.at)))
  }
  for (const label of model.file.labels) safe.add(gKey(label.at))
  model.file.wires = model.file.wires.filter((wire) => {
    const hit = removedPoints.has(gKey(wire.pts[0])) || removedPoints.has(gKey(wire.pts[1]))
    if (!hit) return true
    const other = removedPoints.has(gKey(wire.pts[0])) ? wire.pts[1] : wire.pts[0]
    return safe.has(gKey(other))
  })
  model.refreshView()
  return { nets: affected, removed: [args.refdes] }
}

export type { SchematicFile }
