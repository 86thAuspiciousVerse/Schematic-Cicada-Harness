/**
 * Canonical serializer: typed {@link SchematicFile} -> minimal `.cicada_sch`
 * text per 8-spec §2.2/§2.3 (properties without effects, explicit pin uuids,
 * boolean-style `(hide yes)`, coordinates as two-decimal mm strings).
 *
 * Library symbol bodies are re-emitted from their parsed node tree (fidelity
 * preserved), while sheet items are emitted in canonical fixed order.
 */

import { GENERATOR, GENERATOR_VERSION, gToMm } from './constants.ts'
import type { G, SchematicFile, Sexpr, SexprItem, SexprLeaf, SymbolItem } from './types.ts'

/** Serialize a parsed model to canonical schematic text. */
export function serialize(file: SchematicFile): string {
  const out: string[] = []
  out.push(
    `(kicad_sch (version ${file.version}) (generator ${quote(file.generator || GENERATOR)}) (generator_version ${quote(file.generatorVersion || GENERATOR_VERSION)})`,
  )
  if (file.uuid) out.push(`  (uuid ${file.uuid})`)
  if (file.paper) out.push(`  (paper ${quote(file.paper)})`)
  if (file.titleBlock) out.push(emitNode(file.titleBlock, 1))
  if (file.libSymbols.length > 0) {
    out.push('  (lib_symbols')
    for (const lib of file.libSymbols) out.push(emitNode(lib.body, 2))
    out.push('  )')
  }
  for (const symbol of file.symbols) out.push(nest(emitSymbolInstance(symbol), '  '))
  for (const wire of file.wires) {
    out.push(
      nest(
        `(wire (pts (xy ${fmt(wire.pts[0].x)} ${fmt(wire.pts[0].y)}) (xy ${fmt(wire.pts[1].x)} ${fmt(wire.pts[1].y)})) (uuid ${wire.uuid}))`,
        '  ',
      ),
    )
  }
  for (const label of file.labels) {
    out.push(nest(`(label ${quote(label.text)} (at ${fmt(label.at.x)} ${fmt(label.at.y)} ${label.rotation}) (uuid ${label.uuid}))`, '  '))
  }
  for (const j of file.junctions) {
    out.push(nest(`(junction (at ${fmt(j.at.x)} ${fmt(j.at.y)}) (uuid ${j.uuid}))`, '  '))
  }
  for (const nc of file.noConnects) {
    out.push(nest(`(no_connect (at ${fmt(nc.at.x)} ${fmt(nc.at.y)}) (uuid ${nc.uuid}))`, '  '))
  }
  if (file.hasSheetInstances) out.push('  (sheet_instances (path "/" (page "1")))')
  out.push(')')
  return `${out.join('\n')}\n`
}

/** Format a G coordinate as a two-decimal mm string. */
export function fmtG(g: G): string {
  return gToMm(g)
}

const fmt = fmtG

/** Quote and escape a schematic string literal. */
export function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Re-emit a parsed node tree normalized at `level` (2-space per level; every line self-padded). */
function emitNode(node: Sexpr, level: number): string {
  const pad = '  '.repeat(level)
  if (isLeafTree(node) && leafCount(node) <= 64) return `${pad}${emitInline(node)}`
  const leaves: string[] = []
  const subs: Sexpr[] = []
  for (const c of node.children) {
    if (isLeaf(c)) leaves.push(emitLeaf(c))
    else subs.push(c)
  }
  const head = leaves.length > 0 ? `(${node.head}${leaves.map((l) => ` ${l}`).join('')}` : `(${node.head}`
  const body = subs.map((c) => emitNode(c, level + 1)).join('\n')
  return `${head}\n${body}\n${pad})`
}

function emitInline(node: Sexpr): string {
  return `(${node.head}${node.children.map((c) => ` ${isSexpr(c) ? emitInline(c) : emitLeaf(c)}`).join('')})`
}

function isLeafTree(node: Sexpr): boolean {
  return node.children.every((c) => isLeaf(c) || (isSexpr(c) && isLeafTree(c)))
}

function leafCount(node: Sexpr): number {
  return node.children.reduce((n, c) => n + (isLeaf(c) ? 1 : isSexpr(c) ? leafCount(c) : 0), 0)
}

function emitLeaf(item: SexprLeaf): string {
  return item.type === 'str' ? quote(item.value) : item.value
}

function isLeaf(item: SexprItem | undefined): item is SexprLeaf {
  return item !== undefined && ((item as SexprLeaf).type === 'str' || (item as SexprLeaf).type === 'atom')
}

function isSexpr(item: SexprItem | undefined): item is Sexpr {
  return item !== undefined && !isLeaf(item)
}

/** Prefix every line with `pad` (for top-level canonical items). */
function nest(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
}

/** Emit one symbol instance in canonical minimal form (8-spec §2.2). */
function emitSymbolInstance(s: SymbolItem): string {
  const lines: string[] = [
    `(symbol (lib_id ${quote(s.libId)}) (at ${fmt(s.at.x)} ${fmt(s.at.y)} ${s.rotation}) (unit ${s.unit})`,
  ]
  if (s.uuid) lines.push(`  (uuid ${s.uuid})`)
  const order = ['Reference', 'Value', 'Footprint', 'Datasheet']
  const keys = [...order.filter((k) => k in s.properties), ...Object.keys(s.properties).filter((k) => !order.includes(k))]
  for (const key of keys) {
    lines.push(`  (property ${quote(key)} ${quote(s.properties[key] ?? '')} (at ${fmt(s.at.x)} ${fmt(s.at.y)} 0))`)
  }
  for (const pin of s.pins) {
    lines.push(`  (pin ${quote(pin.number)} (uuid ${pin.uuid}))`)
  }
  lines[lines.length - 1] = `${lines[lines.length - 1]})`
  return lines.join('\n')
}
