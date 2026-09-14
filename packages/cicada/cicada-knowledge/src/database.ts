/**
 * Global datasheet database (single writer = anchor-audited upsert by this
 * service; AI has no write-DB tool). Root is caller-resolved
 * (`resolveDshHome(configured)`), never a machine literal.
 *
 * One entry is keyed by the exact IC part number and stored as three separate
 * artifacts: `index.json` (group list), `detail/<group_id>.json` (per-group pin
 * data) and `shape.json` (symbol shape block), plus `full.md` (the extracted
 * datasheet text). They can arrive at different times, so every reader asks for
 * their presence explicitly (`statusOf`).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { DatasheetDetailFile, DatasheetGroup, DatasheetIndexFile, ShapeBlock } from './schema.ts'

export type { DatasheetDetailFile, DatasheetGroup, DatasheetIndexFile, DatasheetPin, SourceClaim, ShapeBlock } from './schema.ts'

/** A complete global database entry. */
export interface DatasheetEntry {
  index: DatasheetIndexFile
  detail: Record<string, DatasheetDetailFile>
  fullMd: string
  /** Shape block (docs/09 §5) — consumed by engine symbol synthesis. */
  shape?: ShapeBlock
}

/** Which of the three artifacts one library entry currently has. */
export interface DatasheetStatus {
  found: boolean
  part_number: string
  haveIndex: boolean
  haveDetail: boolean
  haveShape: boolean
  groups: number
  /** Group ids whose `detail/<id>.json` is still missing. */
  missingDetailGroups: string[]
  audited?: boolean | undefined
  modified_at?: number | undefined
}

const DATASHEETS_DIR = 'datasheets'

/** Plain-read access to the global store. */
export class GlobalDatasheetDb {
  constructor(private readonly root: string) {}

  private dirOf(part: string): string {
    return join(this.root, DATASHEETS_DIR, part)
  }

  /** Parse one entry's index, or undefined when the entry does not exist. */
  private readIndex(part: string): DatasheetIndexFile | undefined {
    const indexPath = join(this.dirOf(part), 'index.json')
    if (!existsSync(indexPath)) return undefined
    try {
      return JSON.parse(readFileSync(indexPath, 'utf8')) as DatasheetIndexFile
    } catch {
      return undefined
    }
  }

  /**
   * Stored part numbers: every folder that carries an `index.json`, sorted.
   * @returns the exact keys `get`/`statusOf` accept (near-miss lookup input).
   */
  parts(): string[] {
    const dir = join(this.root, DATASHEETS_DIR)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && existsSync(join(dir, item.name, 'index.json')))
      .map((item) => item.name)
      .sort()
  }

  /** Read one entry (index + detail + full.md + shape), or undefined when absent. */
  get(part: string): DatasheetEntry | undefined {
    const index = this.readIndex(part)
    if (index === undefined) return undefined
    const dir = this.dirOf(part)
    const detail: DatasheetEntry['detail'] = {}
    for (const group of index.groups) {
      const path = join(dir, 'detail', `${group.group_id}.json`)
      // Only files that exist: a missing detail is a gap the caller must see
      // (statusOf/missingDetailGroups), never a fabricated empty group.
      if (!existsSync(path)) continue
      try {
        detail[group.group_id] = JSON.parse(readFileSync(path, 'utf8')) as DatasheetDetailFile
      } catch {
        // unreadable detail stays absent for the same reason
      }
    }
    const fullMdPath = join(dir, 'full.md')
    const fullMd = existsSync(fullMdPath) ? readFileSync(fullMdPath, 'utf8') : ''
    const shape = this.shapeOf(part)
    return { index, detail, fullMd, ...(shape === undefined ? {} : { shape }) }
  }

  /** The stored shape block, or undefined when this part has none yet. */
  shapeOf(part: string): ShapeBlock | undefined {
    const path = join(this.dirOf(part), 'shape.json')
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ShapeBlock
    } catch {
      return undefined
    }
  }

  /**
   * Upsert one entry (caller MUST have run the anchor audit first — this is
   * the only write path into the global DB).
   */
  put(part: string, entry: DatasheetEntry): void {
    const dir = this.dirOf(part)
    mkdirSync(join(dir, 'detail'), { recursive: true })
    const index: DatasheetIndexFile = { ...entry.index, part_number: part, modified_at: Date.now() }
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 1))
    for (const group of index.groups) {
      const body = entry.detail[group.group_id]
      // Detail files exist for pin-carrying groups only; a prose-only group has
      // nothing to detail.
      if (body === undefined && group.pins.length === 0) continue
      writeFileSync(join(dir, 'detail', `${group.group_id}.json`), JSON.stringify(body ?? { part_number: part, group_id: group.group_id, title: group.title, pins: group.pins }, null, 1))
    }
    writeFileSync(join(dir, 'full.md'), entry.fullMd)
    // Shape is additive: an entry written without one keeps any stored block.
    if (entry.shape !== undefined) writeFileSync(join(dir, 'shape.json'), JSON.stringify(entry.shape, null, 1))
  }

  /**
   * The 1↔3 status of one part: index / detail / shape are independent
   * artifacts, and a caller can only decide what to reuse (and what is still
   * owed) when all three are reported.
   * @param part - exact IC part number.
   * @returns presence flags plus the group count and the detail gaps.
   */
  statusOf(part: string): DatasheetStatus {
    const index = this.readIndex(part)
    if (index === undefined) {
      return {
        found: false,
        part_number: part,
        haveIndex: false,
        haveDetail: false,
        haveShape: false,
        groups: 0,
        missingDetailGroups: [],
      }
    }
    const groups: DatasheetGroup[] = index.groups ?? []
    const pinGroups = groups.filter((group) => (group.pins ?? []).length > 0)
    const missingDetailGroups = pinGroups
      .filter((group) => !existsSync(join(this.dirOf(part), 'detail', `${group.group_id}.json`)))
      .map((group) => group.group_id)
    return {
      found: true,
      part_number: part,
      haveIndex: true,
      haveDetail: pinGroups.length > 0 && missingDetailGroups.length === 0,
      haveShape: this.shapeOf(part) !== undefined,
      groups: groups.length,
      missingDetailGroups,
      audited: index.audited,
      modified_at: index.modified_at,
    }
  }
}
