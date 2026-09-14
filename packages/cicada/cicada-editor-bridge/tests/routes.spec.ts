import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEditorRouteHandler, extractBearer, extractQueryToken, type EditorBridgeDeps } from '../src/routes.ts'
import { BRAND_ICON_PATH, BRAND_MARK_PATH, ENTER_EDIT_PATH, INITIAL_WORKSPACE_PATH, LEAVE_EDIT_PATH, SELECTION_PATH, STATE_PATH, SYNC_PATH, WS_PATH, type SelectionItem } from '../src/contract.ts'

const TOKEN = 'tok_ABC-xyz_123'
const SESSION_ID = 'session-main'

function fakeSession(id = SESSION_ID) {
  return { id, header: { cwd: '/workspace' } } as never
}

function makeDeps(overrides: Partial<EditorBridgeDeps> = {}): EditorBridgeDeps {
  const injectSelection = overrides.injectSelection ?? vi.fn()
  return {
    trustedHosts: [],
    matchesToken: presented => presented === TOKEN,
    resolveSession: requested => (requested === undefined || requested === SESSION_ID ? fakeSession() : undefined),
    readStateSession: async () => fakeSession(),
    queueSelection: vi.fn(),
    injectSelection,
    readBaseline: async () => 'deadbeef',
    port: () => 3123,
    schematicFileName: 'schematic.cicada_sch',
    maxRequestBodyBytes: 1024,
    ...overrides,
  }
}

describe('extractBearer', () => {
  it('parses a Bearer header', () => {
    expect(extractBearer('Bearer tok_1')).toBe('tok_1')
  })

  it('refuses non-Bearer and empty values', () => {
    expect(extractBearer('Basic abc')).toBeUndefined()
    expect(extractBearer('Bearer ')).toBeUndefined()
    expect(extractBearer(undefined)).toBeUndefined()
  })
})

describe('extractQueryToken', () => {
  it('parses the ?token= fallback', () => {
    expect(extractQueryToken(`/cicada/editor/state?token=${TOKEN}`)).toBe(TOKEN)
  })

  it('returns undefined for missing or empty token', () => {
    expect(extractQueryToken('/cicada/editor/state')).toBeUndefined()
    expect(extractQueryToken('/cicada/editor/state?token=')).toBeUndefined()
    expect(extractQueryToken(undefined)).toBeUndefined()
  })
})

describe('editor route handler', () => {
  let server: Server | undefined
  let base = ''

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close(err => (err === undefined ? resolve() : reject(err)))
      })
      server = undefined
    }
  })

  async function serve(deps: EditorBridgeDeps): Promise<string> {
    const handler = createEditorRouteHandler(deps)
    server = createServer((req, res) => {
      void handler(req, res)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${String((server!.address() as AddressInfo).port)}`
    return base
  }

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
      body: JSON.stringify(body),
    })
  }

  function get(path: string, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } })
  }

  it('401 without a token', async () => {
    await serve(makeDeps())
    const res = await fetch(`${base}${SELECTION_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
  })

  it('401 with a wrong token', async () => {
    await serve(makeDeps())
    const res = await post(SELECTION_PATH, { selection: [] }, { authorization: 'Bearer wrong' })
    expect(res.status).toBe(401)
  })

  it('403 for a forged Host header (undici cannot set Host, so use node:http)', async () => {
    await serve(makeDeps())
    // fetch refuses to set the Host header; drive the raw request so the
    // Host fence actually sees an attacker domain.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: new URL(base).port,
        path: SELECTION_PATH,
        method: 'POST',
        headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ selection: [] }))
    })
    expect(status).toBe(403)
  })

  it('200 and injects a valid selection (body sessionId passed through)', async () => {
    const injectSelection = vi.fn()
    const resolveSession = vi.fn((requested?: string) => fakeSession(requested))
    await serve(makeDeps({ injectSelection, resolveSession }))
    const selection: SelectionItem[] = [{ kind: 'symbol', refdes: 'R1', uuid: 'u-1', net: ['NET1'] }]
    const res = await post(SELECTION_PATH, { selection, sessionId: SESSION_ID })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, sessionId: SESSION_ID, injected: true })
    expect(resolveSession).toHaveBeenCalledWith(SESSION_ID)
    expect(injectSelection).toHaveBeenCalledWith(fakeSession(), selection)
  })

  it('200 and queues the selection for the next turn when attachNextTurn is set', async () => {
    const queueSelection = vi.fn()
    await serve(makeDeps({ queueSelection }))
    const selection: SelectionItem[] = [{ kind: 'wire', uuid: 'u-3' }]
    const res = await post(SELECTION_PATH, { selection, sessionId: SESSION_ID, attachNextTurn: true })
    expect(res.status).toBe(200)
    expect(queueSelection).toHaveBeenCalledWith(SESSION_ID, selection)
  })

  it('queues a cold session (no live agent) when attachNextTurn is set', async () => {
    const queueSelection = vi.fn()
    await serve(makeDeps({ queueSelection, resolveSession: () => undefined }))
    const selection: SelectionItem[] = [{ kind: 'symbol', refdes: 'R9' }]
    const res = await post(SELECTION_PATH, { selection, sessionId: 'cold-session-id', attachNextTurn: true })
    expect(res.status).toBe(200)
    expect(queueSelection).toHaveBeenCalledWith('cold-session-id', selection)
  })

  it('500 when attachNextTurn is set but no sessionId resolves', async () => {
    await serve(makeDeps({ resolveSession: () => undefined }))
    const res = await post(SELECTION_PATH, { selection: [{ kind: 'wire' }], attachNextTurn: true })
    expect(res.status).toBe(500)
  })

  it('200 and injects into the resolved root when no sessionId is given', async () => {
    const injectSelection = vi.fn()
    await serve(makeDeps({ injectSelection }))
    const res = await post(SELECTION_PATH, { selection: [{ kind: 'wire', uuid: 'u-2' }] })
    expect(res.status).toBe(200)
    expect(injectSelection).toHaveBeenCalledTimes(1)
  })

  it('400 for a non-boolean attachNextTurn', async () => {
    await serve(makeDeps())
    const res = await post(SELECTION_PATH, { selection: [{ kind: 'wire' }], attachNextTurn: 'yes' })
    expect(res.status).toBe(400)
  })

  it('400 for a malformed selection body', async () => {
    await serve(makeDeps())
    const res = await post(SELECTION_PATH, { selection: [{ kind: 'bogus' }] })
    expect(res.status).toBe(400)
    const res2 = await post(SELECTION_PATH, { selection: 'R1' })
    expect(res2.status).toBe(400)
  })

  it('400 for a non-JSON body', async () => {
    await serve(makeDeps())
    const res = await fetch(`${base}${SELECTION_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('500 when no live agent session resolves', async () => {
    await serve(makeDeps({ resolveSession: () => undefined }))
    const res = await post(SELECTION_PATH, { selection: [{ kind: 'symbol' }] })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'no main agent session' })
  })

  it('413 for an oversized body', async () => {
    await serve(makeDeps({ maxRequestBodyBytes: 16 }))
    const res = await post(SELECTION_PATH, { selection: [{ kind: 'symbol', refdes: 'R1' }] })
    expect(res.status).toBe(413)
  })

  it('200 state snapshot with session and baseline', async () => {
    await serve(makeDeps())
    const res = await get(STATE_PATH)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      port: 3123,
      file: 'schematic.cicada_sch',
      sessionId: SESSION_ID,
      cwd: '/workspace',
      baselineHash: 'deadbeef',
      warnings: [],
    })
  })

  it('state falls back to a parked session (cwd reported) when no live agent', async () => {
    await serve(makeDeps({ resolveSession: () => undefined }))
    const res = await get(STATE_PATH)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      port: 3123,
      file: 'schematic.cicada_sch',
      sessionId: SESSION_ID,
      cwd: '/workspace',
      baselineHash: 'deadbeef',
      warnings: [],
    })
  })

  it('state warns when no session exists at all', async () => {
    await serve(makeDeps({ resolveSession: () => undefined, readStateSession: () => undefined }))
    const res = await get(STATE_PATH)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessionId?: string; cwd?: string; warnings: string[] }
    expect(body.sessionId).toBeUndefined()
    expect(body.cwd).toBeUndefined()
    expect(body.warnings).toEqual(['no main agent session'])
  })

  it('state snapshot works with the ?token= query fallback', async () => {
    await serve(makeDeps())
    const res = await fetch(`${base}${STATE_PATH}?token=${TOKEN}`)
    expect(res.status).toBe(200)
  })

  it('rejects a query token on the POST selection mutation', async () => {
    await serve(makeDeps())
    const res = await fetch(`${base}${SELECTION_PATH}?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('426 for a plain GET on the WS path', async () => {
    await serve(makeDeps())
    const res = await get(WS_PATH)
    expect(res.status).toBe(426)
  })

  it('rejects a query token on the plain HTTP WS path', async () => {
    await serve(makeDeps())
    const res = await fetch(`${base}${WS_PATH}?token=${TOKEN}`)
    expect(res.status).toBe(401)
  })

  it('404 for an unknown path under the prefix', async () => {
    await serve(makeDeps())
    const res = await get('/cicada/editor/nope')
    expect(res.status).toBe(404)
  })

  it('405 for a GET on the selection path', async () => {
    await serve(makeDeps())
    const res = await get(SELECTION_PATH)
    expect(res.status).toBe(405)
  })

  it('405 for a GET on the sync path', async () => {
    await serve(makeDeps())
    const res = await get(SYNC_PATH)
    expect(res.status).toBe(405)
  })

  it('200 syncs the engine document for the requested session', async () => {
    const syncEngineDocument = vi.fn(async (sessionId?: string) => ({
      ok: true,
      sessionId,
      file: '/workspace/.cicada/schematic.cicada_sch',
      cwd: '/workspace',
    }))
    await serve(makeDeps({ syncEngineDocument }))
    const res = await post(SYNC_PATH, { sessionId: SESSION_ID })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      sessionId: SESSION_ID,
      file: '/workspace/.cicada/schematic.cicada_sch',
      cwd: '/workspace',
    })
    expect(syncEngineDocument).toHaveBeenCalledWith(SESSION_ID)
  })

  it('200 accepts an empty sync body (resolve the main session)', async () => {
    const syncEngineDocument = vi.fn(async () => ({ ok: true, sessionId: SESSION_ID }))
    await serve(makeDeps({ syncEngineDocument }))
    const res = await fetch(`${base}${SYNC_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(syncEngineDocument).toHaveBeenCalledWith(undefined)
  })

  it('400 for a malformed sync body', async () => {
    await serve(makeDeps({ syncEngineDocument: vi.fn(async () => ({ ok: true })) }))
    const res = await post(SYNC_PATH, { sessionId: 42 })
    expect(res.status).toBe(400)
  })

  it('sync reports no-engine when the bridge wired no engine client', async () => {
    await serve(makeDeps())
    const res = await post(SYNC_PATH, {})
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: false, reason: 'no-engine' })
  })

  it('the launcher project is handed out exactly once', async () => {
    // The page reads it on first load; a reload must not adopt it again.
    let pending: string | undefined = 'C:\\proj\\cicada2'
    await serve(makeDeps({ takeInitialWorkspace: () => { const value = pending; pending = undefined; return value } }))
    const first = await fetch(`${base}${INITIAL_WORKSPACE_PATH}`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ path: 'C:\\proj\\cicada2' })
    const second = await fetch(`${base}${INITIAL_WORKSPACE_PATH}`, { headers: { 'sec-fetch-site': 'same-origin' } })
    await expect(second.json()).resolves.toEqual({})
  })

  it('no launcher project (or no wired taker) answers an empty body, and the route needs page trust', async () => {
    await serve(makeDeps())
    const none = await fetch(`${base}${INITIAL_WORKSPACE_PATH}`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(none.status).toBe(200)
    await expect(none.json()).resolves.toEqual({})
    // A cross-site caller without the editor token is refused like every other page route.
    const untrusted = await fetch(`${base}${INITIAL_WORKSPACE_PATH}`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(untrusted.status).toBe(403)
  })

  it('sync is reachable from the same-origin page without the editor token', async () => {
    const syncEngineDocument = vi.fn(async () => ({ ok: true, sessionId: SESSION_ID }))
    await serve(makeDeps({ syncEngineDocument }))
    const res = await fetch(`${base}${SYNC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
  })

  it('enter-edit takes the human lease and reports the mode', async () => {
    const enterEdit = vi.fn(() => ({ ok: true, mode: 'human-editing' as const }))
    await serve(makeDeps({ enterEdit, lockMode: () => 'human-editing' }))
    const res = await post(ENTER_EDIT_PATH, {})
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, mode: 'human-editing' })
    expect(enterEdit).toHaveBeenCalledTimes(1)
  })

  it('enter-edit is refused with 409 while an agent turn holds the lock', async () => {
    const enterEdit = vi.fn(() => ({ ok: false, mode: 'agent-editing' as const }))
    await serve(makeDeps({ enterEdit, lockMode: () => 'agent-editing' }))
    const res = await post(ENTER_EDIT_PATH, {})
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ ok: false, mode: 'agent-editing' })
  })

  it('leave-edit releases the human lease', async () => {
    const leaveEdit = vi.fn(() => ({ ok: true, mode: 'idle' as const }))
    await serve(makeDeps({ leaveEdit, lockMode: () => 'idle' }))
    const res = await post(LEAVE_EDIT_PATH, {})
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, mode: 'idle' })
  })

  it('405 for a GET on the lock paths', async () => {
    await serve(makeDeps())
    expect((await get(ENTER_EDIT_PATH)).status).toBe(405)
    expect((await get(LEAVE_EDIT_PATH)).status).toBe(405)
  })

  it('lock paths report idle when no lock is wired (回退安全)', async () => {
    await serve(makeDeps())
    const res = await post(ENTER_EDIT_PATH, {})
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, mode: 'idle' })
  })

  it('state snapshot carries the lock mode', async () => {
    await serve(makeDeps({ lockMode: () => 'agent-editing' }))
    const res = await get(STATE_PATH)
    await expect(res.json()).resolves.toMatchObject({ lock: 'agent-editing' })
  })

  it('serves the brand icon bytes', async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await serve(makeDeps({ brandIcon: () => ({ body, contentType: 'image/png' }) }))
    const res = await get(BRAND_ICON_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body)
  })

  it('brand icon is reachable from the same-origin page without the editor token', async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await serve(makeDeps({ brandIcon: () => ({ body, contentType: 'image/png' }) }))
    const res = await fetch(`${base}${BRAND_ICON_PATH}`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(res.status).toBe(200)
  })

  it('404 when no brand icon is configured', async () => {
    await serve(makeDeps())
    expect((await get(BRAND_ICON_PATH)).status).toBe(404)
  })

  it('405 for a POST on the brand icon path', async () => {
    await serve(makeDeps({ brandIcon: () => ({ body: Buffer.from('x'), contentType: 'image/png' }) }))
    const res = await post(BRAND_ICON_PATH, {})
    expect(res.status).toBe(405)
  })

  it('serves the sidebar brand mark bytes', async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])
    await serve(makeDeps({ brandMark: () => ({ body, contentType: 'image/png' }) }))
    const res = await get(BRAND_MARK_PATH)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body)
  })

  it('404 when no brand mark is configured', async () => {
    await serve(makeDeps())
    expect((await get(BRAND_MARK_PATH)).status).toBe(404)
  })
})
