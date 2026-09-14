#!/usr/bin/env -S node --import tsx/esm
/**
 * `cicada` dev CLI (P5, 9-impl §1.9): single-instance lock + ping + spawn the
 * dsh host for the cicada profile, forward host stdout/stderr, release the
 * lock on exit.
 *
 * Flow (9-impl §2.7 + P5 定案 F1-F9):
 *   resolveDshHome → initProfile (idempotent) → fast-path ping →
 *   read lock pid → stale? (pid dead + ping refused) clear → acquire lock →
 *   re-check ping (race window) → spawnHost → forward → await exit → release.
 *
 * Exit codes: 0 = started / focused an existing instance; 1 = lock timeout /
 * port conflict / spawn failure; 130 = SIGINT (host follows the same).
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, DEFAULT_PORT, initProfile, ping, spawnHost, StdoutParser } from '../src/launcher.ts'
import { resolveDshHome } from '../src/home.ts'

/** Dev dsh CLI entry: the repository source, loaded via tsx (mirrors root script `dsh`). */
const DEV_DSH_ENTRY = join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'cli', 'src', 'bin.ts')
/** Dev preload for TS source (root script `dsh` convention). */
const DEV_PRELOAD = 'tsx/esm'

/** Wait/retry policy while the first instance is still booting (E5). */
const BOOT_RETRY_COUNT = 10
const BOOT_RETRY_MS = 1000

/** Is `pid` alive (in this pid namespace)? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read the owner pid from the lock file, when present. */
function lockOwnerPid(home: string): number | undefined {
  const lockPath = join(home, '.cicada.lock')
  if (!existsSync(lockPath)) return undefined
  try {
    const raw = readFileSync(lockPath, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Remove a lock whose owner is no longer alive (or whose pid is unreadable). */
function clearStaleLock(home: string): void {
  rmSync(join(home, '.cicada.lock'), { force: true })
}

async function main(): Promise<number> {
  const home = resolveDshHome()
  const port = DEFAULT_PORT
  initProfile(home)

  // Fast path: an instance is already answering.
  const live = await ping(port)
  if (live.ok) {
    console.log(`cicada: 已有实例在运行 (pid ${live.pid ?? '?'})，请聚焦既有窗口`)
    return 0
  }

  // Lock present → is its owner alive? A live owner means the first instance
  // is still booting (dev boot is slow): wait for ping instead of clearing.
  const owner = lockOwnerPid(home)
  if (owner !== undefined && pidAlive(owner)) {
    for (let i = 0; i < BOOT_RETRY_COUNT; i += 1) {
      await new Promise((r) => setTimeout(r, BOOT_RETRY_MS))
      const again = await ping(port)
      if (again.ok) {
        console.log(`cicada: 已有实例在运行 (pid ${again.pid ?? '?'})，请聚焦既有窗口`)
        return 0
      }
    }
    console.error('cicada: 检测到启动中的实例，但等待超时；请稍后重试')
    return 1
  }

  // A dead owner cannot release its lock. Clear it only after the fast-path
  // ping already refused, so a live host is never displaced by a stale pid
  // check or a pid-reuse window.
  if (existsSync(join(home, '.cicada.lock'))) clearStaleLock(home)

  // Stale lock (owner dead + ping refused): clear it, then acquire.
  const lock = await acquireLock(home)
  if (!lock.acquired) {
    // A live lock appeared between our checks — someone else is starting.
    console.error(`cicada: 实例锁被占用 (pid ${lock.pid ?? '?'})，请稍后重试`)
    return 1
  }

  // Race window: another instance may have started after we took the lock.
  const recheck = await ping(port)
  if (recheck.ok) {
    await lock.release()
    console.log(`cicada: 已有实例在运行 (pid ${recheck.pid ?? '?'})，请聚焦既有窗口`)
    return 0
  }

  // Port occupied by a non-cicada program (answering but not our ping)?
  const portProbe = await ping(port)
  if (portProbe.ok) {
    await lock.release()
    console.error(`cicada: 端口 ${port} 被非 cicada 程序占用`)
    return 1
  }

  const child = spawnHost([], { dshHome: home, dshEntry: DEV_DSH_ENTRY, preload: DEV_PRELOAD })
  const parser = new StdoutParser()

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    parser.push(text)
    process.stdout.write(text)
  })
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))

  const onSignal = (): void => {
    // Ctrl+C tears the host down with us (E4: no orphan holding port 3123).
    child.kill('SIGTERM')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(signal !== null ? 130 : (code ?? 1))
    })
    child.on('error', () => resolve(1))
  })

  await lock.release()
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  return exitCode
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    console.error(`cicada: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
