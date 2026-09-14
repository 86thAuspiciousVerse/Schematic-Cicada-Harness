/**
 * cicadaEngineClient — M1b 库道：runtime 向 cicada-engine 查询符号几何
 * （/lib/list、/lib/get）。服务由 host 环境变量 CICADA_ENGINE_URL/TOKEN 注入；
 * 引擎不可达时调用方按"无库"降级（tools 的错误提示走 kind/part_number）。
 */

/** Engine-backed symbol geometry (raw engine units: IU; runtime converts to G). */
export interface EngineSymbol {
  /** Canonical library key the engine resolved (`category:name`; docs/09 §1). */
  libId: string
  name: string
  pins: readonly { number: string; name: string; x: number; y: number; angle: number }[]
}

/** M1e-1 shape block (semantics only — geometry is engine-deterministic, docs/02 附录 A). */
export interface EngineShapeBlock {
  name: string
  refPrefix?: string
  description?: string
  pins: readonly { number: string; name: string; electrical: string; side?: string }[]
}

export interface CicadaEngineClient {
  /** All loaded symbol names (builtin + curated/user library). */
  listSymbols(): Promise<string[]>
  /** Full `/lib/list` projection (libId/name/category/pins) — library catalog for AI tools. */
  listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]>
  /** Symbol geometry by library key (`category:name`) or unique name tail; unknown → undefined. */
  getSymbol(name: string): Promise<EngineSymbol | undefined>
  /** Runtime workspace switch: point the engine at another `.cicada_sch` ("" = empty document). */
  setDocument(file: string): Promise<{ ok: boolean; error?: string }>
  /** The `.cicada_sch` the engine currently serves (`/scene.file`); undefined when unreachable. */
  currentDocument(): Promise<string | undefined>
  /** M1e-1: synthesize a user-library symbol from a shape block (engine-deterministic geometry). */
  synthesize(block: EngineShapeBlock): Promise<{ ok: boolean; libId?: string; warnings?: string[]; error?: string }>
}

function toEngineSymbol(body: {
  libId?: string
  name?: string
  pins?: { number?: string; name?: string; x?: number; y?: number; angle?: number }[]
}): EngineSymbol | undefined {
  if (body.name === undefined) return undefined
  return {
    libId: body.libId ?? body.name,
    name: body.name,
    pins: (body.pins ?? []).map((p) => ({
      number: p.number ?? '',
      name: p.name ?? '',
      x: p.x ?? 0,
      y: p.y ?? 0,
      angle: p.angle ?? 0,
    })),
  }
}

export function createEngineClient(url: string, token: string): CicadaEngineClient {
  return {
    async listSymbols(): Promise<string[]> {
      const res = await fetch(`${url}/lib/list`, {
        headers: { 'X-Cicada-Token': token },
      })
      if (!res.ok) return []
      const body = (await res.json()) as { symbols?: { name?: string }[] }
      return (body.symbols ?? []).map((s) => s.name ?? '').filter(Boolean)
    },
    async listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]> {
      const res = await fetch(`${url}/lib/list`, {
        headers: { 'X-Cicada-Token': token },
      })
      if (!res.ok) return []
      const body = (await res.json()) as { symbols?: { libId?: string; name?: string; category?: string; pins?: number }[] }
      return (body.symbols ?? [])
        .map((s) => ({ libId: s.libId ?? '', name: s.name ?? '', category: s.category ?? '', pins: s.pins ?? 0 }))
        .filter((s) => s.libId !== '')
    },
    async setDocument(file: string): Promise<{ ok: boolean; error?: string }> {
      const res = await fetch(`${url}/document`, {
        method: 'POST',
        headers: { 'X-Cicada-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
        return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` }
      }
      return { ok: true }
    },
    async currentDocument(): Promise<string | undefined> {
      const res = await fetch(`${url}/scene`, { headers: { 'X-Cicada-Token': token } })
      if (!res.ok) return undefined
      const body = (await res.json()) as { file?: string }
      return body.file
    },
    async getSymbol(libId: string): Promise<EngineSymbol | undefined> {
      // 键模型（docs/09）：/lib/get 按字面键命中 → name-only 唯一回退；按原样发送即可。
      const res = await fetch(`${url}/lib/get`, {
        method: 'POST',
        headers: { 'X-Cicada-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ libId }),
      })
      if (!res.ok) return undefined
      return toEngineSymbol((await res.json()) as Parameters<typeof toEngineSymbol>[0])
    },
    async synthesize(block: EngineShapeBlock): Promise<{ ok: boolean; libId?: string; warnings?: string[]; error?: string }> {
      const res = await fetch(`${url}/lib/synthesize`, {
        method: 'POST',
        headers: { 'X-Cicada-Token': token, 'Content-Type': 'application/json' },
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
  }
}
