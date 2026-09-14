/**
 * Env-backed engine client fallback (headless/dev): the product bridge
 * (`cicada-editor-bridge`) provides the `cicadaEngineClient` service but is
 * coupled to the web server; a headless profile has no web server, so the
 * runtime also accepts a direct env contract (same shape as the bridge
 * client): CICADA_ENGINE_URL + CICADA_ENGINE_TOKEN.
 *
 * Client surface: listSymbols / listLibrary / getSymbol / synthesize /
 * setDocument — mirror of the bridge's engine_client.ts (kept local because
 * the runtime cannot depend on the bridge: the bridge depends on the runtime).
 */

export interface EnvEngineSymbol {
  /** Canonical library key echoed by the engine (`category:name`). */
  libId: string
  name: string
  pins: readonly { number: string; name: string; x: number; y: number; angle: number }[]
}

export interface EnvEngineClient {
  listSymbols(): Promise<string[]>
  listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]>
  getSymbol(name: string): Promise<EnvEngineSymbol | undefined>
  synthesize(block: {
    name: string
    refPrefix?: string
    description?: string
    pins: readonly { number: string; name: string; electrical: string; side?: string }[]
  }): Promise<{ ok: boolean; libId?: string; warnings?: string[]; error?: string }>
  setDocument(file: string): Promise<{ ok: boolean; error?: string }>
}

function baseUrl(): string | undefined {
  const url = typeof process !== 'undefined' ? process.env.CICADA_ENGINE_URL : undefined
  if (url === undefined || url === '') return undefined
  return url.replace(/\/+$/, '')
}

/** Env-configured client, or undefined when the engine env vars are absent. */
export function createEngineClientFromEnv(): EnvEngineClient | undefined {
  const url = baseUrl()
  const token = typeof process !== 'undefined' ? process.env.CICADA_ENGINE_TOKEN : undefined
  if (url === undefined || token === undefined || token === '') return undefined

  const headers = (): Record<string, string> => ({ 'X-Cicada-Token': token })
  return {
    async listSymbols(): Promise<string[]> {
      const res = await fetch(`${url}/lib/list`, { headers: headers() })
      if (!res.ok) return []
      const body = (await res.json()) as { symbols?: { name?: string }[] }
      return (body.symbols ?? []).map((s) => s.name ?? '').filter(Boolean)
    },
    async listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]> {
      const res = await fetch(`${url}/lib/list`, { headers: headers() })
      if (!res.ok) return []
      const body = (await res.json()) as { symbols?: { libId?: string; name?: string; category?: string; pins?: number }[] }
      return (body.symbols ?? [])
        .map((s) => ({ libId: s.libId ?? '', name: s.name ?? '', category: s.category ?? '', pins: s.pins ?? 0 }))
        .filter((s) => s.libId !== '')
    },
    async getSymbol(libId: string): Promise<EnvEngineSymbol | undefined> {
      const res = await fetch(`${url}/lib/get`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ libId }),
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as {
        libId?: string
        name?: string
        pins?: { number?: string; name?: string; x?: number; y?: number; angle?: number }[]
      }
      if (body.name === undefined) return undefined
      return {
        libId: body.libId ?? libId,
        name: body.name,
        pins: (body.pins ?? []).map((p) => ({
          number: p.number ?? '',
          name: p.name ?? '',
          x: p.x ?? 0,
          y: p.y ?? 0,
          angle: p.angle ?? 0,
        })),
      }
    },
    async synthesize(block): Promise<{ ok: boolean; libId?: string; warnings?: string[]; error?: string }> {
      const res = await fetch(`${url}/lib/synthesize`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(block),
      })
      const body = (await res.json().catch(() => undefined)) as
        | { ok?: boolean; libId?: string; warnings?: string[]; error?: { message?: string } }
        | undefined
      if (!res.ok || body?.ok !== true) {
        return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` }
      }
      return body.libId === undefined
        ? { ok: true, warnings: body.warnings ?? [] }
        : { ok: true, libId: body.libId, warnings: body.warnings ?? [] }
    },
    async setDocument(file: string): Promise<{ ok: boolean; error?: string }> {
      const res = await fetch(`${url}/document`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
        return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` }
      }
      return { ok: true }
    },
  }
}
