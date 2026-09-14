/**
 * DSH_HOME resolution for the product (7-arch §5.1 / 9-impl §1.9).
 *
 * DSH itself has no `CICADA_HOME`; the launcher owns the product default
 * (`~/.cicada/home`) and lets `CICADA_HOME` override it as the debug escape
 * hatch. The resolved value is exported to the child process as `DSH_HOME`
 * (must be set — otherwise the host falls back to `~/.dsh`).
 */

import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'

/** Default product data root name under the home directory. */
export const CICADA_HOME_DIRNAME = '.cicada'
/** Default DSH_HOME location name. */
export const DSH_HOME_DIRNAME = 'home'
/** Environment variable that overrides the product data root. */
export const CICADA_HOME_ENV = 'CICADA_HOME'

/**
 * Resolve the product DSH_HOME.
 * @param configured - explicit configured path (from settings/launcher config); wins over env.
 * @param env - environment read (injectable for tests); defaults to `process.env`.
 * @returns the absolute DSH_HOME, never a machine-specific literal constant.
 */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = configured ?? env[CICADA_HOME_ENV]
  const base = explicit !== undefined && explicit !== '' ? explicit : join(homedir(), CICADA_HOME_DIRNAME, DSH_HOME_DIRNAME)
  // Keep injected POSIX absolute paths absolute on Windows as well. This is
  // useful for the debug escape hatch and keeps the resolver platform-neutral
  // for callers that supply a path from a remote/workspace context.
  return base.startsWith('/') ? posix.resolve(base) : isAbsolute(base) ? resolve(base) : join(homedir(), base)
}
