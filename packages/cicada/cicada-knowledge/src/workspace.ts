/**
 * Workspace-side datasheet reads (producer lane): the pin-universe source
 * consumed by the runtime op host, and the group index/detail readers backing
 * `datasheet_workspace_list` / `datasheet_workspace_read_group`.
 *
 * Read-only; workspace writes in this package are confined to the library
 * copy/publish tools (async, through `ctx.fs`) and the ledger tool.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { DatasheetPinSource } from '@deepseek-ai/dsh-cicada-runtime'

import type { DatasheetDetailFile, DatasheetGroup, DatasheetPin, ExternalComponent, OperatingLimit, PinFunction, ShapeBlock, SourceClaim } from './schema.ts'
import type { DatasheetEntry } from './database.ts'

/** The workspace index of one part (full hybrid groups: publish needs the claims too). */
export interface WorkspaceIndex {
  part_number: string
  /** Contract version the artifact declares; the publish audit keys its v3 rules on it. */
  schema_version?: string
  groups: DatasheetGroup[]
}


/**
 * Pin normalization: the v2 contract and the v0.3 artifacts the earlier
 * pipeline produced disagree on details (`physical_number` may be a number,
 * `electrical` may be an object `{direction, pin_type}`, the name may be
 * `name`), so both are accepted and reduced to the v2 shape on read.
 */
function normalizePin(raw: unknown): DatasheetPin | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const pin = raw as Record<string, unknown>
  const number = pin.physical_number ?? pin.physicalNumber
  if (number === undefined || number === null || String(number).trim() === '') return undefined
  const electrical = pin.electrical ?? pin.type
  const electricalText = typeof electrical === 'string'
    ? electrical
    : electrical !== null && typeof electrical === 'object'
      ? String((electrical as Record<string, unknown>).pin_type ?? (electrical as Record<string, unknown>).direction ?? '')
      : ''
  const name = pin.canonical_name ?? pin.name
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const functions = normalizeList(pin.functions, normalizePinFunction)
  return {
    physical_number: String(number),
    ...typeof name === 'string' && name !== '' ? { canonical_name: name } : {},
    ...electricalText !== '' ? { electrical: electricalText } : {},
    ...strings(pin.aliases).length > 0 ? { aliases: strings(pin.aliases) } : {},
    ...strings(pin.source_claim_ids).length > 0 ? { source_claim_ids: strings(pin.source_claim_ids) } : {},
    ...functions.length === 0 ? {} : { functions },
  }
}

/** String-array normalization shared by the v3 readers. */
function stringsOnly(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Normalize one array of v3 objects, dropping unusable entries. */
function normalizeList<T>(value: unknown, one: (raw: unknown) => T | undefined): T[] {
  return (Array.isArray(value) ? value : []).map(one).filter((item): item is T => item !== undefined)
}

/** External-component normalization (v3; also accepts the older `kind`/`element_label`/`connection_method` keys). */
function normalizeExternalComponent(raw: unknown): ExternalComponent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const kind = item.ref_kind ?? item.kind ?? item.element_kind
  if (kind === undefined || String(kind).trim() === '') return undefined
  const count = item.count
  const claims = stringsOnly(item.source_claim_ids)
  return {
    ref_kind: String(kind),
    value: String(item.value ?? item.element_label ?? ''),
    connection: String(item.connection ?? item.connection_method ?? ''),
    ...count === undefined || count === null ? {} : { count: count as number | string },
    ...typeof item.why === 'string' ? { why: item.why } : {},
    ...claims.length === 0 ? {} : { source_claim_ids: claims },
  }
}

/** Operating-limit normalization (v3). */
function normalizeOperatingLimit(raw: unknown): OperatingLimit | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const name = item.name ?? item.parameter
  if (name === undefined || String(name).trim() === '') return undefined
  const claims = stringsOnly(item.source_claim_ids)
  return {
    name: String(name),
    ...typeof item.value === 'string' ? { value: item.value } : {},
    ...typeof item.condition === 'string' ? { condition: item.condition } : {},
    ...claims.length === 0 ? {} : { source_claim_ids: claims },
  }
}

/** Pin-function normalization (v3). */
function normalizePinFunction(raw: unknown): PinFunction | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const name = item.name ?? item.function_id
  if (name === undefined || String(name).trim() === '') return undefined
  return {
    name: String(name),
    ...typeof item.role === 'string' ? { role: item.role } : {},
    ...typeof item.conditions === 'string' ? { conditions: item.conditions } : {},
  }
}

/** The v3 group-level design-guidance block, normalized (shared by index and detail). */
function v3Guidance(raw: Record<string, unknown>): Partial<DatasheetGroup> {
  const designNotes = stringsOnly(raw.design_notes)
  const externalComponents = normalizeList(raw.external_components, normalizeExternalComponent)
  const operatingLimits = normalizeList(raw.operating_limits, normalizeOperatingLimit)
  return {
    ...typeof raw.description === 'string' ? { description: raw.description } : {},
    ...designNotes.length === 0 ? {} : { design_notes: designNotes },
    ...externalComponents.length === 0 ? {} : { external_components: externalComponents },
    ...operatingLimits.length === 0 ? {} : { operating_limits: operatingLimits },
  }
}

/** Claim normalization: the v0.3 claims already match the v2 field names. */
function normalizeClaim(raw: unknown): SourceClaim | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const claim = raw as Record<string, unknown>
  if (typeof claim.claim_id !== 'string' || claim.claim_id === '') return undefined
  return {
    claim_id: claim.claim_id,
    source_kind: typeof claim.source_kind === 'string' ? claim.source_kind : 'datasheet_text',
    source_ref: typeof claim.source_ref === 'string' ? claim.source_ref : '',
    ...typeof claim.section === 'string' ? { section: claim.section } : {},
    extracted_fact: typeof claim.extracted_fact === 'string' ? claim.extracted_fact : '',
    ...typeof claim.verbatim_excerpt === 'string' ? { verbatim_excerpt: claim.verbatim_excerpt } : {},
    ...typeof claim.confidence === 'string' ? { confidence: claim.confidence } : {},
  }
}

/** Group normalization: v2 `groups[]` and legacy `indexes[]` (with `pins_summary`). */
function normalizeGroup(raw: unknown): DatasheetGroup | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const group = raw as Record<string, unknown>
  const id = group.group_id ?? group.id
  if (id === undefined || String(id).trim() === '') return undefined
  const pinsRaw = Array.isArray(group.pins) ? group.pins : Array.isArray(group.pins_summary) ? group.pins_summary : []
  const location = group.location !== null && typeof group.location === 'object' ? group.location as DatasheetGroup['location'] : undefined
  return {
    group_id: String(id),
    title: typeof group.title === 'string' ? group.title : '',
    ...typeof group.category === 'string' ? { category: group.category } : {},
    ...typeof group.priority === 'string' ? { priority: group.priority } : {},
    ...typeof group.brief === 'string' ? { brief: group.brief } : {},
    ...v3Guidance(group),
    ...location === undefined ? {} : { location },
    pins: pinsRaw.map(normalizePin).filter((pin): pin is DatasheetPin => pin !== undefined),
    source_claims: (Array.isArray(group.source_claims) ? group.source_claims : [])
      .map(normalizeClaim)
      .filter((claim): claim is SourceClaim => claim !== undefined),
  }
}

/** The raw group array of either index shape, or undefined when neither is usable. */
function rawGroups(file: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(file.groups)) return file.groups
  if (Array.isArray(file.indexes)) return file.indexes
  return undefined
}

const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** The datasheet folder of one part inside a workspace. */
export function datasheetDir(workspace: string, part: string): string {
  return join(workspace, 'datasheet', part)
}

/** Why a workspace index could not be read (the publish tool reports this verbatim). */
export type WorkspaceIndexRead =
  | { state: 'ok'; index: WorkspaceIndex }
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }

/**
 * Read the workspace index of a part, accepting BOTH the v2 `groups[]` shape and
 * the legacy v0.3 `indexes[]` one (a model that finds older artifacts on disk
 * tends to copy their schema). Reports absent vs unusable separately, so a
 * caller can say which one happened instead of "file not found" for both.
 * @param workspace - workspace root.
 * @param part - exact part number (also the folder name).
 * @returns the normalized index, or why it is missing.
 */
export function readWorkspaceIndexFile(workspace: string, part: string): WorkspaceIndexRead {
  const path = join(datasheetDir(workspace, part), 'index.json')
  if (!existsSync(path)) return { state: 'absent' }
  let file: Record<string, unknown>
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    return { state: 'invalid', reason: `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）` }
  }
  const groups = rawGroups(file)
  if (groups === undefined) return { state: 'invalid', reason: '没有 groups[]（v2）或 indexes[]（v0.3）数组' }
  const normalized = groups.map(normalizeGroup).filter((group): group is DatasheetGroup => group !== undefined)
  if (normalized.length === 0) return { state: 'invalid', reason: '每个组都缺 group_id' }
  return {
    state: 'ok',
    index: {
      part_number: typeof file.part_number === 'string' ? file.part_number : part,
      ...typeof file.schema_version === 'string' ? { schema_version: file.schema_version } : {},
      groups: normalized,
    },
  }
}

/** Read the workspace index of a part (undefined when absent or unusable). */
export function readWorkspaceIndex(workspace: string, part: string): WorkspaceIndex | undefined {
  const read = readWorkspaceIndexFile(workspace, part)
  return read.state === 'ok' ? read.index : undefined
}

/** Read one workspace detail group (pins normalized from either schema). */
export function readWorkspaceDetail(workspace: string, part: string, groupId: string): DatasheetDetailFile | undefined {
  const file = readJson<Record<string, unknown>>(join(datasheetDir(workspace, part), 'detail', `${groupId}.json`))
  if (file === undefined) return undefined
  const pins = (Array.isArray(file.pins) ? file.pins : [])
    .map(normalizePin)
    .filter((pin): pin is DatasheetPin => pin !== undefined)
  return {
    ...typeof file.part_number === 'string' ? { part_number: file.part_number } : {},
    group_id: typeof file.group_id === 'string' ? file.group_id : groupId,
    ...typeof file.title === 'string' ? { title: file.title } : {},
    pins,
    // `notes` is a string in some legacy artifacts — accept both (measured 2026-09-13: a
    // string note was dropped silently on read).
    ...Array.isArray(file.notes)
      ? { notes: file.notes.filter((note): note is string => typeof note === 'string') }
      : typeof file.notes === 'string' && file.notes !== '' ? { notes: [file.notes] } : {},
    ...Array.isArray(file.source_claim_ids) ? { source_claim_ids: file.source_claim_ids.filter((id): id is string => typeof id === 'string') } : {},
    ...v3Guidance(file),
  }
}

/**
 * Pin-universe source for the runtime op host: merges every detail group of
 * the workspace copy. Absent/incomplete knowledge yields undefined (the op
 * reports `datasheet_missing` / `pin_universe_incomplete` downstream).
 *
 * `expected` counts the pins the INDEX declares (distinct union — the runtime
 * rejects duplicates across groups, so a group may only carry pins it owns),
 * while `groups` carries the DETAIL pins. A missing detail file therefore shows
 * up as an incomplete universe instead of silently shrinking it.
 */
export function workspaceDatasheetPins(workspace: string, part: string): DatasheetPinSource | undefined {
  const index = readWorkspaceIndex(workspace, part)
  if (index === undefined) return undefined
  const groups: DatasheetPinSource['groups'][number][] = []
  const declared = new Set<string>()
  for (const group of index.groups) {
    // The detail file is the pin authority for this lane: a missing detail must
    // stay an INCOMPLETE universe (the op then refuses to synthesize a symbol),
    // so the index only contributes to `expected`, never to the pins themselves.
    const detail = readWorkspaceDetail(workspace, part, group.group_id)
    for (const pin of group.pins) declared.add(String(pin.physical_number ?? ''))
    const pins = detail?.pins ?? []
    groups.push(pins.map((pin) => ({
      physicalNumber: String(pin.physical_number ?? ''),
      ...pin.canonical_name === undefined ? {} : { name: pin.canonical_name },
      ...pin.electrical === undefined ? {} : { type: pin.electrical },
    })))
  }
  return { part_number: part, groups, expected: declared.size }
}

/** What one workspace datasheet folder offers, for `datasheet_workspace_list`. */
export interface WorkspaceDatasheetSummary {
  part_number: string
  /** Whether `datasheet/<part>/shape.json` exists (symbol synthesis input). */
  has_shape: boolean
  groups: { group_id: string; title: string; description: string; pin_count: number; has_detail: boolean }[]
}

/**
 * Index-level summary of every workspace datasheet copy (never full detail):
 * which IC folders exist, their index groups, and whether each group's detail
 * file and the part's shape block are present.
 */
export function listWorkspaceGroups(workspace: string): WorkspaceDatasheetSummary[] {
  const partsDir = join(workspace, 'datasheet')
  if (!existsSync(partsDir)) return []
  const out: WorkspaceDatasheetSummary[] = []
  for (const part of readdirSync(partsDir)) {
    const index = readWorkspaceIndex(workspace, part)
    if (index === undefined) continue
    out.push({
      part_number: part,
      has_shape: readWorkspaceShapeBlock(workspace, part) !== undefined,
      groups: index.groups.map((group) => {
        const detail = readWorkspaceDetail(workspace, part, group.group_id)
        return {
          group_id: group.group_id,
          title: group.title,
          description: group.description ?? '',
          pin_count: (detail?.pins.length ?? 0) > 0 ? detail!.pins.length : group.pins.length,
          has_detail: detail !== undefined,
        }
      }),
    })
  }
  return out
}

/**
 * M1e-1 自动查缺源：workspace `datasheet/<part>/shape.json`（与 index/detail 平级的
 * 独立形状块文件；docs/09 §5 拍板）。缺失/解析失败 → undefined。
 */
export function readWorkspaceShapeBlock(workspace: string, part: string): ShapeBlock | undefined {
  const block = readJson<ShapeBlock>(join(datasheetDir(workspace, part), 'shape.json'))
  return block === undefined || !Array.isArray(block.pins) ? undefined : block
}

/**
 * M1e-1 自动查缺源（回退）：workspace 根目录 `shape.json`——仅当块内 `name` 与请求
 * 的 part 一致才返回（防张冠李戴；未命中/不一致 → undefined）。
 */
export function readWorkspaceRootShapeBlock(workspace: string, part: string): ShapeBlock | undefined {
  const block = readJson<ShapeBlock>(join(workspace, 'shape.json'))
  return block !== undefined && block.name === part ? block : undefined
}

/** The raw datasheet text of one workspace copy (empty string when absent). */
export function readWorkspaceFullMd(workspace: string, part: string): string {
  const path = join(datasheetDir(workspace, part), 'full.md')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Why a workspace datasheet entry could not be assembled (publish reports this). */
export type WorkspaceEntryRead =
  | { state: 'ok'; entry: DatasheetEntry }
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }

/**
 * Assemble the publishable entry from one workspace datasheet folder.
 *
 * Normalizes the two layouts into one v2 entry: the workspace may follow the
 * v0.3 arrangement (prose summary in `index.json`, pins in `detail/<id>.json`)
 * or the v2 one (pins in both). The detail is the pin authority; the index
 * group ends up carrying the same pins, which is what the library stores.
 * @param workspace - workspace root.
 * @param part - exact part number (also the folder name).
 * @returns the entry, or why it cannot be assembled.
 */
export function readWorkspaceEntry(workspace: string, part: string): WorkspaceEntryRead {
  const read = readWorkspaceIndexFile(workspace, part)
  if (read.state === 'absent') return { state: 'absent' }
  if (read.state === 'invalid') return read
  const detail: Record<string, DatasheetDetailFile> = {}
  const groups = read.index.groups.map((group) => {
    const file = readWorkspaceDetail(workspace, part, group.group_id)
    if (file === undefined) return group
    const pins = file.pins.length > 0 ? file.pins : group.pins
    detail[group.group_id] = { ...file, pins }
    return { ...group, pins }
  })
  const shape = readWorkspaceShapeBlock(workspace, part)
  return {
    state: 'ok',
    entry: {
      // The workspace's OWN declared version travels to the audit; hardcoding '2' here
      // silently disabled every v3 rule on the publish path (measured 2026-09-13).
      index: { schema_version: read.index.schema_version ?? '2', part_number: part, audited: true, groups },
      detail,
      fullMd: readWorkspaceFullMd(workspace, part),
      ...shape === undefined ? {} : { shape },
    },
  }
}
