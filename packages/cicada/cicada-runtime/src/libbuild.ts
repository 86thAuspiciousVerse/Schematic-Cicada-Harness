/**
 * Library-symbol entry builders for the runtime (8-spec §2.3 / §5.2).
 *
 * Every lib entry is produced as canonical text and parsed back into the
 * format model through `parseSexpr` — the text is the single source for pin
 * slots, and `extractLibPins` reads exactly what KiCad will read.
 */

import type { CoordG, LibPinSpec, LibSymbolSpec, Sexpr, SexprItem } from '@deepseek-ai/dsh-cicada-format'
import { parseSexpr } from '@deepseek-ai/dsh-cicada-format'
import { icBox, icPins } from '@deepseek-ai/dsh-cicada-symbols'

/** G → mm string (two decimals), same projection as the symbols builders. */
const mm = (g: number): string => (g / 100).toFixed(2)

/** mm string → G units (extraction reads canonical text, which is mm). */
// mm 文本 → 整数 G。必须**取整**：`29.85 * 100` 在 IEEE double 下是 2984.9999999999995，
// 而引擎载入端是四舍五入（kicad_sexpr_adapter.cpp:150 的 +0.5）——不取整就会让同一根脚在
// runtime 与引擎里差一个网格（实测：NC 标记因此压不中连接点、网表照旧报 unconnected）。
const g = (mmText: string): number => Math.round(Number.parseFloat(mmText) * 100)

/** Key tail: `category:name` / `cicada:name` → `name` (docs/09 §1). */
const tailOf = (key: string): string => {
  const sep = key.lastIndexOf(':')
  return sep >= 0 ? key.slice(sep + 1) : key
}

function isNode(item: SexprItem): item is Sexpr {
  return (item as { head?: unknown }).head !== undefined
}

function isLeaf(item: SexprItem): item is { type: 'atom' | 'str'; value: string } {
  return (item as { head?: unknown }).head === undefined
}

function valueOfLeaf(item: SexprItem | undefined): string | undefined {
  if (item === undefined || !isLeaf(item)) return undefined
  return item.type === 'atom' || item.type === 'str' ? item.value : undefined
}

/** First child of a named child node, as a leaf string. */
function atomOf(node: Sexpr, head: string): string | undefined {
  const child = node.children.find((item): item is Sexpr => isNode(item) && item.head === head)
  return child === undefined ? undefined : valueOfLeaf(child.children[0])
}

/** Parse a `(at x y a)` node into coordinate plus angle. */
function atOf(node: Sexpr, head: string): { at: CoordG; angle: number } | undefined {
  const child = node.children.find((item): item is Sexpr => isNode(item) && item.head === head)
  if (child === undefined) return undefined
  const [x, y, angle] = child.children
  const sx = valueOfLeaf(x)
  const sy = valueOfLeaf(y)
  const sa = valueOfLeaf(angle)
  if (sx === undefined || sy === undefined || sa === undefined) return undefined
  return { at: { x: Number.parseFloat(sx), y: Number.parseFloat(sy) }, angle: Number(sa) }
}

/** All pins of a `lib_symbols` entry text (the `<name>_1_1` body). */
export function extractLibPins(body: Sexpr): LibPinSpec[] {
  const out: LibPinSpec[] = []
  for (const child of body.children) {
    if (!isNode(child) || child.head !== 'symbol') continue
    const nameNode = child.children[0]
    const name = valueOfLeaf(nameNode)
    if (name === undefined || !name.endsWith('_1_1')) continue
    for (const pin of child.children) {
      if (!isNode(pin) || pin.head !== 'pin') continue
      const type = valueOfLeaf(pin.children[0])
      const shape = valueOfLeaf(pin.children[1])
      const at = atOf(pin, 'at')
      if (type === undefined || shape === undefined || at === undefined) continue
      const length = g(atomOf(pin, 'length') ?? '0')
      out.push({
        number: atomOf(pin, 'number') ?? '',
        name: atomOf(pin, 'name') ?? '',
        at: { x: g(String(at.at.x)), y: g(String(at.at.y)) },
        angle: at.angle,
        length,
        type,
        shape,
      })
    }
  }
  return out
}

/** Build a parsed lib entry from canonical text. */
export function libSpecFromText(text: string, flags: { power?: boolean; pinNumbersHidden?: boolean }): LibSymbolSpec {
  const body = parseSexpr(text)
  const fullName = valueOfLeaf(body.children[0]) ?? ''
  const name = tailOf(fullName)
  return {
    libId: fullName,
    name,
    power: flags.power ?? false,
    pinNumbersHidden: flags.pinNumbersHidden ?? false,
    pins: extractLibPins(body),
    body,
  }
}

/**
 * Canonical `lib_symbols` text for a generated n-pin IC (8-spec §2.5).
 * @param libKey full library key (`IC:<part>`); sub-symbol bodies carry the tail.
 * @param pins pin table in placement order.
 */
export function icLibText(
  libKey: string,
  pins: readonly { number: string; name: string; type: string }[],
): string {
  const libName = tailOf(libKey)
  const n = pins.length
  const box = icBox(n)
  const slots = icPins(n)
  const slotByNumber = new Map(slots.map((slot) => [slot.number, slot]))
  const halfW = box.width / 2
  const halfH = box.height / 2
  const bodies = [
    `  (symbol "${libName}_0_1"`,
    `    (rectangle (start ${mm(-halfW)} ${mm(-halfH)}) (end ${mm(halfW)} ${mm(halfH)})))`,
    `  (symbol "${libName}_1_1"`,
    ...pins.map((pin) => {
      const slot = slotByNumber.get(pin.number)
      const at = slot?.at ?? { x: 0, y: 0 }
      const angle = slot?.angle ?? 0
      const length = slot?.length ?? 254
      return `    (pin ${pin.type || 'passive'} line (at ${mm(at.x)} ${mm(at.y)} ${angle}) (length ${mm(length)}) (name "${pin.name}" ) (number "${pin.number}" ))`
    }),
    `  ))`,
  ]
  return [
    `(symbol "${libKey}" (pin_names (offset 0.508))`,
    `  (property "Reference" "${libName}" (at 0 0 0))`,
    `  (property "Value" "${libName}" (at 0 0 0))`,
    ...bodies,
  ].join('\n')
}

/**
 * Canonical `lib_symbols` text for a library symbol loaded from a .kicad_sym
 * (M1b 库道): pins carry exact geometry (G units) from the engine, the body is
 * the pin bbox plus a 1.27mm margin.
 * @param libKey full library key from the engine (`category:name`); sub-symbol
 *   bodies and the Reference/Value defaults carry the tail.
 * @param pins pin geometry in G units: { number, name, x, y, angle }
 */
export function libEntryText(
  libKey: string,
  pins: readonly { number: string; name: string; x: number; y: number; angle: number }[],
): string {
  const libName = tailOf(libKey)
  const margin = 127 // 1.27mm in G
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pins) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) {
    minX = -1000
    maxX = 1000
    minY = -1000
    maxY = 1000
  }
  const halfW = (maxX - minX) / 2 + margin
  const halfH = (maxY - minY) / 2 + margin
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const length = 254 // 2.54mm pin length
  const bodies = [
    `  (symbol "${libName}_0_1"`,
    `    (rectangle (start ${mm(cx - halfW)} ${mm(cy - halfH)}) (end ${mm(cx + halfW)} ${mm(cy + halfH)})))`,
    `  (symbol "${libName}_1_1"`,
    ...pins.map(
      (p) =>
        `    (pin passive line (at ${mm(p.x)} ${mm(p.y)} ${p.angle}) (length ${mm(length)}) (name "${p.name}" ) (number "${p.number}" ))`,
    ),
    `  ))`,
  ]
  return [
    `(symbol "${libKey}" (pin_names (offset 0.508))`,
    `  (property "Reference" "${libName}" (at 0 0 0))`,
    `  (property "Value" "${libName}" (at 0 0 0))`,
    ...bodies,
  ].join('\n')
}
