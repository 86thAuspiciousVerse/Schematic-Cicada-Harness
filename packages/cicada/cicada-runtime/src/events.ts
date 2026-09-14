import type { ChangelogEntry } from './changelog.ts'

/** Runtime publication emitted only after the corresponding sidecars commit. */
export interface CicadaRuntimeChange {
  workspace: string
  file: string
  origin: 'ai-write' | 'watcher' | 'baseline'
  baselineVersion: string
  baselineHash: string
  entries: ChangelogEntry[]
}
