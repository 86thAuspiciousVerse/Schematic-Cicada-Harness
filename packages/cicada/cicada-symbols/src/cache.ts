/**
 * Global symbol cache: deterministic store/load of generated lib symbol
 * entries under an injected cache root (the caller supplies the resolved
 * DSH_HOME-derived directory — host plugins write outside the workspace via
 * direct node:fs per E21-A4). Writes are tmp+rename atomic.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError(`symbol cache: invalid name ${JSON.stringify(name)}`)
  return name
}

/** Per-root symbol cache. */
export class SymbolCache {
  /** @param root - cache directory (e.g. `~/.cicada/symbols` resolved by the caller). */
  constructor(private readonly root: string) {}

  /** Load the cached lib symbol entry text by lib item name. */
  load(name: string): string | undefined {
    const path = join(this.root, `${safeName(name)}.sym`)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }

  /** Store (or replace) the lib symbol entry text atomically. */
  store(name: string, text: string): void {
    const path = join(this.root, `${safeName(name)}.sym`)
    const tmp = `${path}.tmp`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  }
}
