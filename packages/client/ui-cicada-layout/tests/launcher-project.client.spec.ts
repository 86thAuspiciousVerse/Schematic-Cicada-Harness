// @vitest-environment jsdom
/**
 * Launcher project adoption (docs/04 §5.2): the bridge hands out the project the
 * launcher window started for, exactly once. Adopting it must register the path
 * and open a session there through DSH's own services — and must stay silent
 * when there is nothing to adopt, when the bridge is unreachable, or when the
 * client services are not there yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/cordis'
import { adoptInitialWorkspace } from '../src/client/index.ts'

/** Client context stub exposing only `ctx.get`. */
function fakeCtx(services: Record<string, unknown>): ClientContext {
  return { get: (name: string) => services[name] } as unknown as ClientContext
}

function bridgeReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }))
}

const services = () => {
  const create = vi.fn(async ({ path }: { path: string }) => ({ workspaceId: `ws-${path}` }))
  const startSession = vi.fn()
  return { create, startSession, ctx: fakeCtx({ workspaces: { create }, uiWorkspace: { startSession } }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('adoptInitialWorkspace', () => {
  it('registers the launcher project and opens a session in it', async () => {
    const { create, startSession, ctx } = services()
    vi.stubGlobal('fetch', bridgeReturning({ path: 'C:\\proj\\cicada2' }))
    await adoptInitialWorkspace(ctx)
    expect(create).toHaveBeenCalledWith({ path: 'C:\\proj\\cicada2' })
    expect(startSession).toHaveBeenCalledWith('ws-C:\\proj\\cicada2')
  })

  it('does nothing when the bridge has no project left (already adopted / reload)', async () => {
    const { create, startSession, ctx } = services()
    vi.stubGlobal('fetch', bridgeReturning({}))
    await adoptInitialWorkspace(ctx)
    expect(create).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('does nothing when the client services are missing', async () => {
    const startSession = vi.fn()
    vi.stubGlobal('fetch', bridgeReturning({ path: 'C:\\proj\\x' }))
    await expect(adoptInitialWorkspace(fakeCtx({}))).resolves.toBeUndefined()
    await expect(adoptInitialWorkspace(fakeCtx({ workspaces: {}, uiWorkspace: { startSession } }))).resolves.toBeUndefined()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('swallows a bridge error (the picker still works by hand)', async () => {
    const { create, ctx } = services()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(adoptInitialWorkspace(ctx)).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', bridgeReturning({}, false))
    await expect(adoptInitialWorkspace(ctx)).resolves.toBeUndefined()
  })

  it('asks the one-shot route with the same-origin page fetch', async () => {
    const { ctx } = services()
    const fetchMock = bridgeReturning({})
    vi.stubGlobal('fetch', fetchMock)
    await adoptInitialWorkspace(ctx)
    expect(fetchMock).toHaveBeenCalledWith('/cicada/editor/initial-workspace', { headers: { accept: 'application/json' } })
  })
})
