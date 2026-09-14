/**
 * Deterministic placement allocation (8-spec §2.4): simple row grid, widths
 * from the placed symbol bbox (pins plus body rectangle), 5.08mm gaps.
 */

import type { CoordG, LibSymbolSpec, Sexpr, SexprItem, SexprLeaf } from '@deepseek-ai/dsh-cicada-format'

/** Bounding box in G units. */
export interface Box {
  w: number
  h: number
}

/** One grid row holds at most 8 symbols (8-spec §2.4). */
export const ROW_CAP = 8
/** Start position: 1 inch from the origin (8-spec §2.4.1). */
export const START_G: CoordG = { x: 2540, y: 2540 }
/** Horizontal/vertical inter-symbol gap (2 × 2.54mm). */
export const GAP_G = 508

/** Bbox of a lib entry: union of pin `at` points and every rectangle body. */
export function bboxOf(lib: LibSymbolSpec): Box {
  let minX = 0
  let maxX = 0
  let minY = 0
  let maxY = 0
  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  for (const pin of lib.pins) include(pin.at.x, pin.at.y)
  for (const child of lib.body.children) {
    const sub = child as SexprItem
    if ((sub as { head?: unknown }).head !== 'symbol') continue
    const body = sub as Sexpr
    for (const item of body.children) {
      if ((item as { head?: unknown }).head !== 'rectangle') continue
      const start = corner(item as Sexpr, 'start')
      const end = corner(item as Sexpr, 'end')
      if (start !== undefined) include(start.x, start.y)
      if (end !== undefined) include(end.x, end.y)
    }
  }
  // 落位必须是整数 G（否则落点会与引擎算出的连接点差一个网格；实测 NC 标记差 1 格）。
  return { w: Math.round(maxX - minX), h: Math.round(maxY - minY) }
}

/** Narrow a sexpr item to a leaf (nodes carry `head`). */
function isLeaf(item: SexprItem): item is SexprLeaf {
  return (item as { head?: unknown }).head === undefined
}

/** Leaf value of a sexpr item, or undefined for a node. */
function leafValue(item: SexprItem | undefined): string | undefined {
  if (item === undefined || !isLeaf(item)) return undefined
  return item.type === 'atom' || item.type === 'str' ? item.value : undefined
}

/** Read `(start x y)` / `(end x y)` of a rectangle body. */
function corner(node: Sexpr, head: string): CoordG | undefined {
  const child = node.children.find((item): item is Sexpr => (item as { head?: unknown }).head === head)
  if (child === undefined) return undefined
  const [x, y] = child.children
  const sx = leafValue(x)
  const sy = leafValue(y)
  if (sx === undefined || sy === undefined) return undefined
  return { x: Number.parseFloat(sx), y: Number.parseFloat(sy) }
}

/**
 * Deterministic next placement slot (8-spec §2.4.2):
 * `x = 25.4 + Σ(w_j + 5.08)` within the row, `y = 25.4 + Σ(h_row + 5.08)`
 * over completed rows; rows hold at most 8 symbols.
 * @param boxes - bbox of every placed symbol in file order.
 * @returns the slot for the NEXT symbol.
 */
export function nextPlacement(
  boxes: readonly Box[],
  isFree?: (slot: CoordG, box: Box) => boolean,
): CoordG {
  const next = boxes.length
  const mine = boxes[next] ?? { w: 0, h: 0 }
  // 逐个候选格试探（同一张图上的结果仍然确定）：被占用就顺延一个序号。
  for (let k = next; k < next + SLOT_PROBES; k += 1) {
    const slot = slotFor(boxes, k)
    if (isFree === undefined || isFree(slot, mine)) return slot
  }
  return slotFor(boxes, next)
}

/** 试探上限（防御用；正常图几格内就有空位）。 */
export const SLOT_PROBES = 512

/** The slot the k-th symbol would occupy on the plain row grid. */
function slotFor(boxes: readonly Box[], k: number): CoordG {
  const row = Math.floor(k / ROW_CAP)
  const col = k % ROW_CAP
  let x = START_G.x
  for (let j = row * ROW_CAP; j < row * ROW_CAP + col; j += 1) {
    const box = boxes[j]
    if (box !== undefined) x += box.w + GAP_G
  }
  let y = START_G.y
  for (let r = 0; r < row; r += 1) {
    let h = 0
    for (let j = r * ROW_CAP; j < (r + 1) * ROW_CAP; j += 1) {
      const box = boxes[j]
      if (box !== undefined) h = Math.max(h, box.h)
    }
    y += h + GAP_G
  }
  // 整数 G：任何分数都会让落点与引擎的连接点错开一个网格。
  return { x: Math.round(x), y: Math.round(y) }
}
