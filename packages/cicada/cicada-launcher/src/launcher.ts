/**
 * Launcher pure-function library (9-impl §1.9 / §2.7).
 *
 * Product shell (wx, later) and the dev CLI both use these helpers; the
 * library itself never spawns or touches the fixed host port except through
 * arguments. All paths are resolved by callers (no machine-specific literals).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { request } from 'node:http'

/** Product default web port (9-impl / E9-D; mirrors the bundle patch `?? 3123`). */
export const DEFAULT_PORT = 3123

/** Single-instance lock file name under DSH_HOME (7-arch §3.3 literal). */
export const LOCK_FILE_NAME = '.cicada.lock'

/** Liveness probe path on the webserver (registered later by the host plugin). */
export const PING_PATH = '/_cicada/ping'

/** Profile name shipped with the product. */
export const PROFILE_NAME = 'cicada'

/** Profile bundles, in layer order (dsh-base ← dsh-web-app ← dsh-cicada-app). */
export const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-cicada-app',
] as const

/**
 * Result of acquiring the single-instance lock.
 * `acquired: true` → caller owns the instance and MUST call `release()` when
 * the host exits (also on failure paths). `acquired: false` + `pid` → another
 * live process holds it (the caller should ping and report).
 */
export interface LockResult {
  acquired: boolean
  /** Owner pid from the lock file, when a lock exists. */
  pid: number | undefined
  /** Release the held lock (only valid when acquired). */
  release: () => Promise<void>
}

/**
 * Acquire the single-instance lock at `home/.cicada.lock` (manual wx+pid,
 * P5 定案 F4/F5: withFileLock is callback-style and its contenders never
 * remove an existing lock — incompatible with our stale cleanup). The lock
 * file content is the owner pid (same shape as atomic-write:138).
 * @param home - resolved DSH_HOME directory (lock lives beside it).
 * @returns LockResult; never throws on contention (returns acquired:false).
 */
export async function acquireLock(home: string): Promise<LockResult> {
  const lockPath = join(home, LOCK_FILE_NAME)
  mkdirSync(home, { recursive: true })
  try {
    await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
    let released = false
    return {
      acquired: true,
      pid: undefined,
      release: async () => {
        if (released) return
        released = true
        await rm(lockPath, { force: true })
      },
    }
  } catch (error) {
    // EEXIST (and Windows EPERM with an existing file) = contention.
    const contender = await lockContended(error, lockPath)
    if (!contender) throw error
    const pidRaw = existsSync(lockPath) ? (await readPid(lockPath)) : undefined
    return { acquired: false, pid: pidRaw, release: async () => {} }
  }
}

/** True when the error is lock-file contention (EEXIST, or Windows EPERM over an existing file). */
async function lockContended(error: unknown, lockPath: string): Promise<boolean> {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') return true
  if ((error as NodeJS.ErrnoException).code === 'EPERM') {
    try {
      const { lstat } = await import('node:fs/promises')
      await lstat(lockPath)
      return true
    } catch {
      return false
    }
  }
  return false
}

/** Read the pid recorded in a lock file (undefined when unreadable/absent). */
async function readPid(lockPath: string): Promise<number | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = (await readFile(lockPath, 'utf8')).trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * Probe the host liveness endpoint: `GET 127.0.0.1:<port>/_cicada/ping`.
 * No token, no sensitive data (E24). Connection refused / timeout / non-200
 * all mean "not our host".
 * @param port - host web port.
 * @param timeoutMs - request timeout (default 1000).
 * @returns ok + the host pid when answered.
 */
export async function ping(port: number, timeoutMs = 1000): Promise<{ ok: boolean; pid: number | undefined }> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: PING_PATH, method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve({ ok: false, pid: undefined }); return }
          try {
            const parsed = JSON.parse(body) as { ok?: boolean; pid?: number }
            resolve({ ok: parsed.ok === true, pid: typeof parsed.pid === 'number' ? parsed.pid : undefined })
          } catch {
            resolve({ ok: false, pid: undefined })
          }
        })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, pid: undefined }) })
    req.on('error', () => resolve({ ok: false, pid: undefined }))
    req.end()
  })
}

/** Product default web port (single protocol constant; see DEFAULT_PORT). */
export function resolvePort(): number {
  return DEFAULT_PORT
}

/** Parsed stdout protocol lines. */
export interface StdoutLines {
  /** `dsh web: <url>` URL (contains the launch token); undefined until seen. */
  webUrl?: string
  /** `cicada-editor: <port> <token>`; undefined until seen. */
  editor?: { port: number; token: string }
}

const WEB_LINE = /^dsh web:\s+(\S+)\s*$/
const EDITOR_LINE = /^cicada-editor:\s+(\d+)\s+([A-Za-z0-9_-]+)\s*$/

/**
 * Parse one stdout line of the host (both protocol lines are emitted once,
 * after the Loader settles; `cicada-editor` overrides on re-emission).
 * @param line - one complete line (no trailing newline required).
 * @returns parsed fields, or a marker that nothing matched.
 */
export function parseStdoutLine(line: string): Partial<StdoutLines> & { matched: boolean } {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const web = WEB_LINE.exec(trimmed)
  const url = web?.[1]
  if (url !== undefined) return { matched: true, webUrl: url }
  const editor = EDITOR_LINE.exec(trimmed)
  const portRaw = editor?.[1]
  const token = editor?.[2]
  if (portRaw !== undefined && token !== undefined) {
    return { matched: true, editor: { port: Number.parseInt(portRaw, 10), token } }
  }
  return { matched: false }
}

/** Accumulate parsed lines across chunks (buffers incomplete trailing lines). */
export class StdoutParser {
  private buffer = ''
  private result: StdoutLines = {}

  /** Feed a chunk of stdout. */
  push(chunk: string): StdoutLines {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      const parsed = parseStdoutLine(line)
      if (parsed.matched) {
        if (parsed.webUrl !== undefined) this.result.webUrl = parsed.webUrl
        if (parsed.editor !== undefined) this.result.editor = parsed.editor
      }
      nl = this.buffer.indexOf('\n')
    }
    return this.result
  }

  /** Current accumulated result. */
  get(): StdoutLines {
    return this.result
  }
}

/**
 * Spawn the dsh host for the product profile.
 *
 * P5 定案 F6: `nodeBin=process.execPath` 直拼 `--profile` 失败（`bad option:
 * --profile`）——dev 源模式必须等价于根 script `node --import tsx/esm
 * apps/cli/src/bin.ts`. The caller supplies the dsh CLI entry (built
 * `lib/bin.js` for installs, the tsx-loaded source for dev) and an optional
 * preload (e.g. `tsx/esm`).
 * @param args - extra `dsh` args (overlays etc.); placed before the web-app
 *   flags, which switch the CLI into pass-through.
 * @param options - dshHome (DSH_HOME env, mandatory), dshEntry (dsh CLI entry
 *   path), preload (optional `--import` specifier), nodeBin, env, cwd (the
 *   project directory the launcher window started for; the host's working
 *   directory is what a new session adopts).
 * @returns the child process (caller owns stdout/stderr parsing and lifecycle).
 */
export function spawnHost(
  args: string[],
  options: {
    dshHome: string
    dshEntry: string
    preload?: string
    nodeBin?: string
    env?: NodeJS.ProcessEnv
    cwd?: string
  },
): ChildProcess {
  const requestedNodeBin = options.nodeBin ?? process.execPath
  // POSIX can execute a shebang-backed .mjs shim directly; Windows cannot
  // spawn script files as executables (it reports EFTYPE). Keep the public
  // nodeBin escape hatch useful for tests/dev shims by routing script paths
  // through the current Node executable on win32.
  const scriptShim = process.platform === 'win32' && ['.js', '.mjs', '.cjs'].includes(extname(requestedNodeBin).toLowerCase())
    ? requestedNodeBin
    : undefined
  const nodeBin = scriptShim === undefined ? requestedNodeBin : process.execPath
  const env = { ...process.env, ...options.env, DSH_HOME: options.dshHome }
  const preloadArgs = options.preload !== undefined ? ['--import', options.preload] : []
  // `args` go BEFORE the web-app flags: `--no-open/--port/--host` switch the CLI
  // into pass-through, so anything after them is handed to the web app and an
  // overlay like `--patch` is refused there ("unknown option '--patch'").
  const argv = [
    ...(scriptShim === undefined ? [] : [scriptShim]),
    ...preloadArgs,
    options.dshEntry,
    '--profile', PROFILE_NAME,
    ...args,
    '--no-open', '--port', String(DEFAULT_PORT), '--host', '127.0.0.1',
  ]
  return spawn(nodeBin, argv, {
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Initialize a profile directory (first-run; existing files are never touched). */
export function initProfile(dshHome: string, bundles: readonly string[] = PROFILE_BUNDLES): void {
  const dir = join(dshHome, 'profiles', PROFILE_NAME)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      // Bundles resolve from the dsh installation anchor (in-box), never from
      // profile-local copies (profile.ts resolveBundleDir: installation
      // first). Dev source mode links them by hand (P2b 冒烟记录); the
      // packaged launcher ships them in-box (M4).
      dependencies: {},
      dsh: { profile: { bundles: [...bundles], patchReload: 'live' } },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    writeFileSync(
      patchPath,
      `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`,
    )
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`)
  }
}

// ── M1d: 产品引擎 spawn + 独立 Edge 窗口 + 启动日志（04 §1） ────────────────

/** Engine announce protocol (docs/02 §1): `cicada-engine: 127.0.0.1:<EP> <ET>`. */
export interface EngineLine { port: number; token: string }

const ENGINE_LINE = /^cicada-engine:\s+127\.0\.0\.1:(\d+)\s+([A-Za-z0-9_-]+)\s*$/

/** Parse one engine stdout line; returns null unless it is the announce. */
export function parseEngineLine(line: string): EngineLine | null {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const match = ENGINE_LINE.exec(trimmed)
  if (match === null) return null
  return { port: Number.parseInt(match[1]!, 10), token: match[2]! }
}

/**
 * Spawn the cicada-engine service (loopback, dynamic port, optionally a
 * workspace file/lib dir). Empty document by default: the host's
 * editor-bridge later points the engine at the active session file via
 * POST /document (M1c mechanism). The caller owns stdout parsing and the
 * child's lifecycle (kill on exit).
 * @param engineExe - absolute path of the engine binary (caller-resolved; see
 *   bin/cicada-app.ts) or a bare command name.
 * @param options - libDir (curated/user libraries), file (initial document),
 *   cwd, env, extraArgs.
 */
export function spawnEngine(
  engineExe: string,
  options: { libDir?: string; file?: string; cwd?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[] } = {},
): ChildProcess {
  const argv = [
    '--port', '0',
    ...(options.file !== undefined && options.file !== '' ? ['--file', options.file] : []),
    ...(options.libDir !== undefined && options.libDir !== '' ? ['--lib-dir', options.libDir] : []),
    ...(options.extraArgs ?? []),
  ]
  return spawn(engineExe, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Edge executable candidates (classic install locations), env-overridable. */
export function edgeCandidates(): string[] {
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const list = pf86 === undefined ? [] : [join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
  if (pf !== undefined && pf !== pf86) list.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  if (process.env.CICADA_EDGE !== undefined) list.unshift(process.env.CICADA_EDGE)
  return [...new Set(list.map((p) => p.split(';').filter(Boolean)))].flat()
}

/** First existing Edge executable, or null. */
export function resolveEdge(): string | null {
  for (const candidate of edgeCandidates()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // env garbage is ignored
    }
  }
  return null
}

/**
 * Open the product window: an INDEPENDENT Edge instance (`--user-data-dir`
 * isolates it from a running Edge so the child stays ours — window close
 * becomes observable). Detached; the caller monitors the child exit.
 */
export function spawnEdgeWindow(edgeExe: string, webUrl: string, profileDir: string): ChildProcess {
  return spawn(edgeExe, [
    `--app=${webUrl}&layout=workspace`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
  ], { stdio: 'ignore', detached: true })
}

/** Append one timestamped line to `logs/launch.txt` under dshHome (04 §3). */
export function appendLaunchLog(dshHome: string, message: string): void {
  try {
    const dir = join(dshHome, 'logs')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString()
    writeFileSync(join(dir, 'launch.txt'), `[${stamp}] ${message}\n`, { flag: 'a' })
  } catch {
    // diagnostics must never take the launcher down
  }
}
