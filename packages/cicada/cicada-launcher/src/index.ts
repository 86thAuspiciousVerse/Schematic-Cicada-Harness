/**
 * `cicada-launcher`: launcher library service + single-instance host half.
 *
 * Provides `cicadaLauncher` with {@link resolveDshHome}, {@link initProfile},
 * {@link StdoutParser}, {@link spawnHost}, {@link acquireLock}, and
 * {@link ping}. The host half registers the `/_cicada/ping` liveness endpoint
 * (exact route, no token, E24) so a second launch can probe the running
 * instance (P5).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver' // Context.webServer merge

import { CICADA_HOME_ENV, CICADA_HOME_DIRNAME, DSH_HOME_DIRNAME, resolveDshHome } from './home.ts'
import {
  acquireLock,
  DEFAULT_PORT,
  initProfile,
  parseStdoutLine,
  PING_PATH,
  ping,
  resolvePort,
  spawnHost,
  StdoutParser,
  type LockResult,
  type StdoutLines,
} from './launcher.ts'

export {
  acquireLock,
  CICADA_HOME_DIRNAME,
  CICADA_HOME_ENV,
  DEFAULT_PORT,
  DSH_HOME_DIRNAME,
  initProfile,
  parseStdoutLine,
  PING_PATH,
  ping,
  resolveDshHome,
  resolvePort,
  spawnHost,
  StdoutParser,
}
export type { LockResult, StdoutLines }

/** Launcher library service registered as `cicadaLauncher`. */
export class CicadaLauncher {
  /** @param ctx - host context. */
  constructor(public readonly ctx: Context) {}

  /** Resolve the product DSH_HOME (CICADA_HOME override, `~/.cicada/home` default). */
  home(configured?: string): string {
    return resolveDshHome(configured)
  }

  /** Initialize (or verify) the cicada profile directory under `dshHome`. */
  initProfile(dshHome: string): void {
    initProfile(dshHome)
  }

  /** Acquire the single-instance lock under `dshHome`. */
  lock(dshHome: string): Promise<LockResult> {
    return acquireLock(dshHome)
  }

  /** Probe the host liveness endpoint on `port`. */
  probe(port: number): Promise<{ ok: boolean; pid: number | undefined }> {
    return ping(port)
  }
}

/** Function-plugin entry: registers the `cicadaLauncher` service + the ping endpoint. */
export const name = 'cicada-launcher'

/** Required services: the webserver (for the ping route). */
export const inject = ['webServer']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.provide('cicadaLauncher', new CicadaLauncher(ctx)))

  // Single-instance liveness probe: exact route, no token, no sensitive data
  // (9-impl §1.9 / E24). The handler owns the whole response lifecycle —
  // webserver does no automatic JSON serialization (webserver:42-48/165-172).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PING_PATH,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, pid: process.pid }))
    },
  }), 'cicada-launcher: ping endpoint')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaLauncher: CicadaLauncher
  }
}
