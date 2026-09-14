import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { CICADA_HOME_ENV, resolveDshHome } from '../src/home.ts'
import { acquireLock, initProfile, parseStdoutLine, ping, spawnHost, StdoutParser , parseEngineLine, spawnEngine } from '../src/launcher.ts'
import { renderTavilyPatch, userLayerDefinesTavily } from '../src/tavily.ts'

describe('resolveDshHome', () => {
  it('defaults to ~/.cicada/home', () => {
    const home = resolveDshHome(undefined, {})
    expect(home.endsWith(join('.cicada', 'home'))).toBe(true)
  })

  it('CICADA_HOME overrides the default (debug escape hatch)', () => {
    const home = resolveDshHome(undefined, { [CICADA_HOME_ENV]: '/tmp/cicada-home-test' })
    expect(home).toBe('/tmp/cicada-home-test')
  })

  it('explicit configured wins over env', () => {
    const home = resolveDshHome('/tmp/explicit', { [CICADA_HOME_ENV]: '/tmp/env' })
    expect(home).toBe('/tmp/explicit')
  })
})

describe('parseStdoutLine', () => {
  it('parses the dsh web line', () => {
    expect(parseStdoutLine('dsh web: http://127.0.0.1:3123/?token=abc123')).toEqual({
      matched: true,
      webUrl: 'http://127.0.0.1:3123/?token=abc123',
    })
  })

  it('parses the cicada-editor line with CRLF tolerance', () => {
    expect(parseStdoutLine('cicada-editor: 3123 tok_1\r')).toEqual({ matched: true, editor: { port: 3123, token: 'tok_1' } })
  })

  it('ignores unrelated lines', () => {
    expect(parseStdoutLine('[info] something else').matched).toBe(false)
  })

  it('handles split chunks without losing either line', () => {
    const parser = new StdoutParser()
    parser.push('dsh web: http://127.0.0.1:3123/?token=a')
    parser.push('bc\ncicada-editor: 3123 tok_1\n')
    const result = parser.get()
    expect(result.webUrl).toBe('http://127.0.0.1:3123/?token=abc')
    expect(result.editor).toEqual({ port: 3123, token: 'tok_1' })
  })

  it('editor line overrides on re-emission', () => {
    const parser = new StdoutParser()
    parser.push('cicada-editor: 3123 old\n')
    parser.push('cicada-editor: 3123 new\n')
    expect(parser.get().editor?.token).toBe('new')
  })
})

describe('initProfile', () => {
  it('writes the profile manifest, patch, and pnpm workspace once', () => {
    const root = mkdtempSync(join(tmpdir(), 'cicada-profile-'))
    try {
      const home = join(root, 'home')
      initProfile(home)
      const dir = join(home, 'profiles', 'cicada')
      expect(existsSync(join(dir, 'package.json'))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      expect(manifest.name).toBe('dsh-profile-cicada')
      expect(manifest.dependencies).toEqual({})
      expect(manifest.dsh.profile.bundles).toEqual([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-cicada-app',
      ])
      expect(manifest.dsh.profile.patchReload).toBe('live')
      expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(true)
      expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(true)

      // Re-running never touches existing files (no-op on initialized profile).
      const before = readFileSync(join(dir, 'package.json'), 'utf8')
      initProfile(home, [])
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('acquireLock', () => {
  it('acquires, records the pid, and releases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cicada-lock-'))
    try {
      const home = join(root, 'home')
      const lock = await acquireLock(home)
      expect(lock.acquired).toBe(true)
      const lockPath = join(home, '.cicada.lock')
      expect(existsSync(lockPath)).toBe(true)
      expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
      await lock.release()
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports contention with the owner pid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cicada-lock-'))
    try {
      const home = join(root, 'home')
      const first = await acquireLock(home)
      expect(first.acquired).toBe(true)
      const second = await acquireLock(home)
      expect(second.acquired).toBe(false)
      expect(second.pid).toBe(process.pid)
      await first.release()
      const third = await acquireLock(home)
      expect(third.acquired).toBe(true)
      await third.release()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is exclusive across processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cicada-lock-'))
    try {
      const home = join(root, 'home')
      const launcherEntry = pathToFileURL(join(__dirname, '..', 'src', 'launcher.ts')).href
      // First child takes the lock and stays alive; second must see contention.
      const heldProbe = `
        import { acquireLock } from ${JSON.stringify(launcherEntry)};
        const lock = await acquireLock(${JSON.stringify(home)});
        if (lock.acquired) { console.log('held'); await new Promise(() => {}); }
        else { console.log('contended'); process.exit(0); }
      `
      const first = spawnSync(process.execPath, ['--import', 'tsx/esm', '-e', heldProbe], { encoding: 'utf8', timeout: 8000 })
      expect(first.stdout).toContain('held')
      const contendedProbe = `
        import { acquireLock } from ${JSON.stringify(launcherEntry)};
        const lock = await acquireLock(${JSON.stringify(home)});
        console.log(lock.acquired ? 'held' : 'contended');
        process.exit(0);
      `
      const second = spawnSync(process.execPath, ['--import', 'tsx/esm', '-e', contendedProbe], { encoding: 'utf8', timeout: 8000 })
      expect(second.stdout).toContain('contended')
      expect(second.status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ping', () => {
  it('parses a healthy ping response', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, pid: 1234 }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const result = await ping(port)
      expect(result).toEqual({ ok: true, pid: 1234 })
    } finally {
      server.close()
    }
  })

  it('reports failure on connection refusal', async () => {
    const result = await ping(1) // nothing listens on port 1
    expect(result.ok).toBe(false)
  })

  it('reports failure on non-200 and malformed bodies', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      expect((await ping(port)).ok).toBe(false)
    } finally {
      server.close()
    }
  })
})

describe('spawnHost', () => {
  it('injects DSH_HOME and passes the dsh entry + profile args', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cicada-spawn-'))
    try {
      // nodeBin shim: a tiny executable that prints DSH_HOME + argv, then
      // exits — proving env injection and the argv contract without booting.
      const shim = join(root, 'shim.mjs')
      writeFileSync(shim, `#!/usr/bin/env node\nconsole.log('DSH_HOME=' + process.env.DSH_HOME)\nconsole.log('argv=' + JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
      const child = spawnHost(['--extra'], {
        dshHome: '/tmp/cicada-home-test',
        dshEntry: '/repo/apps/cli/src/bin.ts',
        preload: 'tsx/esm',
        nodeBin: shim,
        env: { PATH: process.env.PATH ?? '' },
      })
      const out = await new Promise<string>((resolve, reject) => {
        let acc = ''
        child.stdout?.on('data', (chunk: Buffer) => { acc += chunk.toString() })
        child.on('exit', () => resolve(acc))
        child.on('error', reject)
      })
      expect(out).toContain('DSH_HOME=/tmp/cicada-home-test')
      const argv = JSON.parse(out.match(/argv=(.*)/)?.[1] ?? '[]') as string[]
      expect(argv[0]).toBe('--import')
      expect(argv[1]).toBe('tsx/esm')
      expect(argv[2]).toBe('/repo/apps/cli/src/bin.ts')
      expect(argv).toContain('--profile')
      expect(argv).toContain('cicada')
      expect(argv).toContain('--port')
      expect(argv).toContain('3123')
      expect(argv).toContain('--host')
      expect(argv).toContain('127.0.0.1')
      // Extra dsh args (overlays) MUST precede the web-app flags: `--no-open`
      // switches the CLI into pass-through, so a `--patch` after it is handed to
      // the web app and refused ("unknown option '--patch'", measured).
      const extraAt = argv.indexOf('--extra')
      expect(extraAt).toBeGreaterThan(argv.indexOf('cicada'))
      expect(extraAt).toBeLessThan(argv.indexOf('--no-open'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M1d engine/edge protocol helpers', () => {
  it('parses the engine announce line (docs/02 §1 protocol)', () => {
    expect(parseEngineLine('cicada-engine: 127.0.0.1:59974 e77358de36a8a96d667fa11da03a13b2\r'))
      .toEqual({ port: 59974, token: 'e77358de36a8a96d667fa11da03a13b2' })
    expect(parseEngineLine('anything else')).toBeNull()
  })

  /** The engine binary does not exist in tests — assert argv, swallow the spawn error. */
  async function engineArgv(opts?: Parameters<typeof spawnEngine>[1]): Promise<string[]> {
    const child = spawnEngine('engine.exe', opts)
    child.on('error', () => { /* engine.exe 不存在：spawn 失败不是本用例目标 */ })
    await new Promise((r) => setTimeout(r, 20))
    return child.spawnargs as string[]
  }

  it('assembles engine argv: port 0 first, optional file/lib-dir', async () => {
    const argv = await engineArgv({ libDir: '/libs', file: '/ws/.cicada/schematic.cicada_sch' })
    expect(argv).toContain('--port')
    expect(argv).toContain('0')
    expect(argv).toContain('--lib-dir')
    expect(argv).toContain('/libs')
    expect(argv).toContain('--file')
    expect(argv).toContain('/ws/.cicada/schematic.cicada_sch')
  })

  it('spawnEngine without file starts an empty document', async () => {
    const argv = await engineArgv()
    expect(argv).not.toContain('--file')
  })
})

describe('renderTavilyPatch', () => {
  it('renders one insert row pointing at the Tavily endpoint with the key', () => {
    const text = renderTavilyPatch('tvly-dev-abc_123')
    expect(text).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(text).toContain('serverName: tavily')
    expect(text).toContain('transport: streamable-http')
    expect(text).toContain('url: \'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev-abc_123\'')
    // Search must not gate the product: a flaky endpoint cannot block boot.
    expect(text).toContain('failOnStartupError: false')
    expect(text.split('\n').filter(line => line.includes('tvly-'))).toHaveLength(1)
  })

  it('url-encodes the key so a special character cannot break the query', () => {
    expect(renderTavilyPatch('t+v y')).toContain('tavilyApiKey=t%2Bv%20y')
  })

  it('warns that the file carries a credential', () => {
    expect(renderTavilyPatch('tvly-x')).toMatch(/credential/i)
  })
})

describe('userLayerDefinesTavily', () => {
  const ROW = '- insert:\n    - id: mcp-tavily\n      name: \'@deepseek-ai/dsh-mcp-client\'\n'

  it('detects the row a user may have added by hand (id is what collides)', () => {
    expect(userLayerDefinesTavily(['/home/profiles/cicada/cordis.patch.yml'], () => ROW)).toBe(true)
    expect(userLayerDefinesTavily(['/a', '/b'], (path) => (path === '/b' ? ROW : '[]'))).toBe(true)
  })

  it('ignores unrelated rows, missing files and near-miss ids', () => {
    expect(userLayerDefinesTavily(['/a'], () => '- insert:\n    - id: mcp-other\n')).toBe(false)
    expect(userLayerDefinesTavily(['/a'], () => '- insert:\n    - id: mcp-tavily-2\n')).toBe(false)
    expect(userLayerDefinesTavily(['/missing'], () => { throw new Error('ENOENT') })).toBe(false)
    expect(userLayerDefinesTavily([], () => ROW)).toBe(false)
  })
})
