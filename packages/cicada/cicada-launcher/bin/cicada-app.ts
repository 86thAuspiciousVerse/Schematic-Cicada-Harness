#!/usr/bin/env -S node --import tsx/esm
/**
 * `cicada-app` product launcher (M1d, docs/04 §1): spawn the cicada-engine
 * service first — its announce line yields EP/ET — then spawn the dsh host
 * with `CICADA_ENGINE_URL/TOKEN` injected, wait for `dsh web:`, and open the
 * product window in an INDEPENDENT Edge `--app` instance. On window close /
 * Ctrl+C / host death the whole stack is torn down (host + engine + lock).
 * `--no-window` prints the URL and stays resident for dev use.
 *
 * Exit codes: 0 = clean close; 1 = preflight/spawn/parse failure; 130 = SIGINT.
 *
 * No machine-specific paths: engine binary via `CICADA_ENGINE_EXE` (default
 * `cicada-engine.exe`), libraries via `CICADA_LIB_DIR`, Edge probed from
 * standard locations (`CICADA_EDGE` override).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTavilyPatch, TAVILY_PATCH_FILE, userLayerDefinesTavily } from '../src/tavily.ts'
import {
  acquireLock, appendLaunchLog, DEFAULT_PORT, initProfile, ping, parseEngineLine,
  PROFILE_NAME, resolveEdge, spawnEdgeWindow, spawnEngine, spawnHost, StdoutParser,
} from '../src/launcher.ts'
import { resolveDshHome } from '../src/home.ts'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read the stale-lock owner pid (content written by acquireLock). */
function lockOwnerPid(home: string): number | undefined {
  const lockPath = join(home, '.cicada.lock')
  try {
    if (!existsSync(lockPath)) return undefined
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * Clear a lock whose owner is no longer alive. A launcher killed without its
 * teardown path (taskkill / dev) leaves a stale lock; without this the next
 * launch would fail forever ("实例锁被占用").
 */
function clearStaleLock(home: string): void {
  rmSync(join(home, '.cicada.lock'), { force: true })
  appendLaunchLog(home, 'stale lock cleared')
}

const DEV_DSH_ENTRY = join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'cli', 'src', 'bin.ts')
/** Harness root, walked up from `<root>/packages/cicada/cicada-launcher/bin`. */
const HARNESS_ROOT = join(import.meta.dirname, '..', '..', '..', '..')
/**
 * Dev preload (tsx) as an ABSOLUTE file URL. A bare `tsx/esm` is resolved by
 * Node against the CHILD's cwd, and since the launcher window starts the host
 * inside the chosen project directory, that lookup failed with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx' imported from <project>`
 * (measured 2026-09-12, launcher window → 启动 cicada2).
 */
const DEV_PRELOAD = import.meta.resolve('tsx/esm')
const ENGINE_ANNOUNCE_TIMEOUT_MS = 30_000
const WEB_URL_TIMEOUT_MS = 120_000
const PRODUCT_TITLE = 'Schematic-Cicada'

/**
 * `--workspace <dir>`: the project directory the launcher window started for
 * (docs/04 §5.2). It becomes the host's working directory and the initial
 * workspace hint the cicada client adopts; DSH registers it on first use, so
 * this flag never writes the workspace registry itself.
 */
function workspaceArg(): string | undefined {
  const index = process.argv.indexOf('--workspace')
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined || value === '' || value.startsWith('--') ? undefined : value
}

async function main(): Promise<number> {
  const noWindow = process.argv.includes('--no-window')
  const workspace = workspaceArg()
  const home = resolveDshHome()
  const port = DEFAULT_PORT
  initProfile(home)
  appendLaunchLog(home, 'launcher start')

  // Preflight: an instance already runs → ask the user to focus it.
  const live = await ping(port)
  if (live.ok) {
    console.log(`cicada: 已有实例在运行 (pid ${live.pid ?? '?'})。请聚焦既有窗口或先关闭再启动。`)
    appendLaunchLog(home, 'preflight: instance already running')
    return 0
  }

  // Stale-lock handling (same policy as bin/cicada.ts): a live owner = another
  // instance still booting → wait for its ping; a dead owner = stale lock →
  // clear it, then acquire.
  const owner = lockOwnerPid(home)
  if (owner !== undefined && pidAlive(owner)) {
    console.log(`cicada: 检测到启动中的实例 (pid ${owner})，等待其就绪…`)
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      const again = await ping(port)
      if (again.ok) {
        console.log(`cicada: 已有实例在运行 (pid ${again.pid ?? '?'})，请聚焦既有窗口。`)
        return 0
      }
    }
    console.error('cicada: 等待启动中的实例超时，请稍后重试')
    return 1
  }
  clearStaleLock(home)

  const lock = await acquireLock(home)
  if (!lock.acquired) {
    console.error(`cicada: 实例锁被占用 (pid ${lock.pid ?? '?'})，请稍后重试`)
    return 1
  }
  const release = async (): Promise<void> => { await lock.release() }

  // ── ① engine first: the announce line yields EP/ET before host spawn ──
  const engineBin = process.env.CICADA_ENGINE_EXE ?? 'cicada-engine.exe'
  const libDir = process.env.CICADA_LIB_DIR
  // M1e-1: 可写用户符号库（/lib/synthesize 落盘处；缺省 = 用户库关闭）
  const userLibDir = process.env.CICADA_USER_LIB_DIR
  appendLaunchLog(home, `spawn engine: ${engineBin}`)
  const engine = spawnEngine(engineBin, {
    libDir,
    ...(userLibDir !== undefined && userLibDir !== '' ? { extraArgs: ['--user-lib-dir', userLibDir] } : {}),
  })
  const engineAnnounce = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ENGINE_ANNOUNCE_TIMEOUT_MS)
    let buffer = ''
    engine.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (parseEngineLine(line) !== null) {
          clearTimeout(timer)
          resolve(line)
          return
        }
      }
    })
    engine.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    engine.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve(null)
      console.error(`cicada: 引擎启动失败: ${error.message}`)
    })
    engine.on('exit', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
  if (engineAnnounce === null) {
    appendLaunchLog(home, 'engine announce timeout/failure')
    await release()
    console.error('cicada: 引擎未就绪（30s 无宣告行）')
    return 1
  }
  const engineInfo = parseEngineLine(engineAnnounce)!
  const engineUrl = `http://127.0.0.1:${engineInfo.port}`
  // Token stays out of the on-disk log; the port is what diagnostics need.
  appendLaunchLog(home, `engine announce: 127.0.0.1:${engineInfo.port} ***`)
  console.log(`cicada: 引擎端口 ${engineInfo.port}`)

  // ── ② host with engine env injected (04 §1.1 order correction) ──
  // Project directory only when it is really there: a deleted project must not
  // turn into a spawn failure with an unreadable cause.
  const projectCwd = workspace !== undefined && existsSync(workspace) ? workspace : undefined
  if (workspace !== undefined && projectCwd === undefined) {
    appendLaunchLog(home, `workspace missing, keeping the launcher cwd: ${workspace}`)
  }
  // Optional Tavily MCP (docs/04 §5.3): the row cannot live in a tracked patch
  // (no `!!js` inside `insert:`, and the URL embeds the key), so it is rendered
  // here from the environment and passed as an extra `--patch`.
  const tavilyArgs: string[] = []
  const tavilyKey = process.env.TAVILY_API_KEY
  const userLayers = [
    join(home, 'cordis.patch.yml'),
    join(home, 'profiles', PROFILE_NAME, 'cordis.patch.yml'),
  ]
  if (userLayerDefinesTavily(userLayers)) {
    // A user-configured row wins: inserting ours too would fail the whole tree
    // with "duplicate loader entry id" (measured).
    appendLaunchLog(home, 'tavily mcp: defined by the user layer, launcher overlay skipped')
  } else if (tavilyKey !== undefined && tavilyKey !== '') {
    try {
      const patchPath = join(home, TAVILY_PATCH_FILE)
      writeFileSync(patchPath, renderTavilyPatch(tavilyKey))
      tavilyArgs.push('--patch', patchPath)
      // The path only: the file itself carries the credential.
      appendLaunchLog(home, `tavily mcp: ${TAVILY_PATCH_FILE}`)
    } catch (error) {
      appendLaunchLog(home, `tavily mcp skipped: ${String(error)}`)
    }
  }

  const host = spawnHost(tavilyArgs, {
    dshHome: home,
    dshEntry: DEV_DSH_ENTRY,
    preload: DEV_PRELOAD,
    ...(projectCwd === undefined ? {} : { cwd: projectCwd }),
    env: {
      CICADA_ENGINE_URL: engineUrl,
      CICADA_ENGINE_TOKEN: engineInfo.token,
      DSH_CLIENT_TITLE: PRODUCT_TITLE,
      // The host no longer runs inside the harness checkout, so tsx must be told
      // where the path-mapping tsconfig lives (it walks up from the cwd otherwise).
      TSX_TSCONFIG_PATH: join(HARNESS_ROOT, 'tsconfig.json'),
      ...(projectCwd === undefined ? {} : { CICADA_INITIAL_WORKSPACE: projectCwd }),
    },
  })
  const parser = new StdoutParser()
  host.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    parser.push(text)
    process.stdout.write(text)
  })
  host.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))

  const url = await new Promise<string | undefined>((resolve) => {
    const deadline = Date.now() + WEB_URL_TIMEOUT_MS
    const timer = setInterval(() => {
      const value = parser.get().webUrl
      if (value !== undefined) {
        clearInterval(timer)
        resolve(value)
        return
      }
      if (Date.now() > deadline) {
        clearInterval(timer)
        resolve(undefined)
        return
      }
    }, 250)
    host.on('exit', () => {
      clearInterval(timer)
      resolve(undefined)
    })
  })
  if (url === undefined) {
    appendLaunchLog(home, 'host web url timeout')
    host.kill()
    if (!engine.killed) engine.kill()
    await release()
    console.error('cicada: host 启动超时（120s 未出 dsh web: 行），已清理')
    return 1
  }
  // The URL carries the session token: keep it out of the on-disk log (the
  // console line above stays complete so a manual open remains possible).
  appendLaunchLog(home, `dsh web: ${url.replace(/([?&]token=)[^&]*/i, '$1***')}`)

  const teardown = async (): Promise<void> => {
    appendLaunchLog(home, `teardown (host ${host.pid ?? '?'}, engine ${engine.pid ?? '?'})`)
    if (!host.killed) host.kill()
    if (!engine.killed) engine.kill()
    await release()
  }

  if (noWindow) {
    console.log(`cicada: 窗口地址 ${url}`)
    console.log('cicada: --no-window；Ctrl+C 退出（整栈清算）')
    return await new Promise<number>((resolve) => {
      const onSig = (): void => { void teardown().then(() => resolve(130)) }
      process.once('SIGINT', onSig)
      process.once('SIGTERM', onSig)
    })
  }

  // ── ③ product window: independent Edge (window close = edge exit) ──
  console.log(`cicada: 窗口地址 ${url}`)
  const edgeBin = resolveEdge()
  if (edgeBin === null) {
    console.log('cicada: 未找到 Edge（CICADA_EDGE 可指定路径）。请手动打开上面的地址；关闭后 Ctrl+C 退出。')
  } else {
    const edge = spawnEdgeWindow(edgeBin, url, join(home, 'edge-app-profile'))
    appendLaunchLog(home, `edge --app: ${edgeBin}`)
    edge.on('exit', () => {
      void teardown().then(() => process.exit(0))
    })
    edge.on('error', () => console.log(`cicada: Edge 打开失败，请手动打开上面的地址`))
  }

  // stay resident: edge exit / host exit / signals own the exit path.
  host.on('exit', () => {
    void teardown().then(() => process.exit(1))
  })
  const onSignal = (): void => { void teardown().then(() => process.exit(130)) }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return await new Promise<number>(() => { /* resolved by exit paths above */ })
}

void main().then((code) => { process.exitCode = code })
