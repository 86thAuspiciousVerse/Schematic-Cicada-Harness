/**
 * Knowledge-landscape gate (docs/05 §8): the knowledge agent writes
 * `<workspace>/.cicada/design_intent.json`, and this reader is what the runtime
 * validates it with before the datasheet lane may start.
 *
 * The check is content-hash based: the caller reports one verdict per file
 * revision, so a fixable violation is announced once instead of every turn.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { validateDesignIntent, type DesignIntent } from './intent.ts'

/** Landscape file name inside the workspace state directory (`.cicada`). */
export const LANDSCAPE_FILE_NAME = 'design_intent.json'

/** `absent` = knowledge lane not started; `unreadable` = missing/invalid JSON. */
export type LandscapeState = 'absent' | 'unreadable' | 'invalid' | 'ok'

/** One landscape verdict. */
export interface LandscapeCheck {
  state: LandscapeState
  /** Full path of the landscape file (also carried when it is absent). */
  path: string
  /** sha256 of the file content; `''` when absent. */
  hash: string
  /** Requested datasheet part numbers in landscape order (state `ok`). */
  datasheetRequired: string[]
  /** Field-level violations (state `invalid`) or the read/parse error. */
  violations: string[]
}

/**
 * Read and validate the knowledge landscape of one workspace.
 * @param stateDir - the workspace state directory (`<cwd>/.cicada`).
 * @returns the verdict; never throws.
 */
export function checkLandscape(stateDir: string): LandscapeCheck {
  const path = join(stateDir, LANDSCAPE_FILE_NAME)
  if (!existsSync(path)) return { state: 'absent', path, hash: '', datasheetRequired: [], violations: [] }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { state: 'unreadable', path, hash: '', datasheetRequired: [], violations: [`无法读取 ${path}：${String(error)}`] }
  }
  const hash = createHash('sha256').update(text).digest('hex')
  let parsed: DesignIntent
  try {
    parsed = JSON.parse(text) as DesignIntent
  } catch (error) {
    return {
      state: 'unreadable',
      path,
      hash,
      datasheetRequired: [],
      violations: [`${LANDSCAPE_FILE_NAME} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const result = validateDesignIntent(parsed)
  return result.ok
    ? { state: 'ok', path, hash, datasheetRequired: result.datasheetRequired, violations: [] }
    : { state: 'invalid', path, hash, datasheetRequired: [], violations: result.violations }
}
