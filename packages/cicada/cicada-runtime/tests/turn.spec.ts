import { describe, expect, it } from 'vitest'

import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CicadaFormat } from '@deepseek-ai/dsh-cicada-format'

import { placeSymbol } from '../src/ops.ts'
import { TurnManager, type FsApi } from '../src/turn.ts'

const format = new CicadaFormat({} as never)

interface Entry {
  content: string
  version: number
}

/** In-memory fs backend honoring the version-guard contract (G3 CAS tests). */
class FakeFs implements FsApi {
  files = new Map<string, Entry>()
  private counter = 1

  async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const cwd = opts?.cwd ?? ''
    return { targetKey: `${cwd}/${path}` as FsTarget['targetKey'], displayPath: `${cwd}/${path}` }
  }

  async stat(target: FsTarget): Promise<{ version: FsVersion; type: 'file' } | undefined> {
    const entry = this.files.get(target.targetKey)
    return entry === undefined ? undefined : { version: String(entry.version) as FsVersion, type: 'file' }
  }

  async readText(target: FsTarget): Promise<string> {
    const entry = this.files.get(target.targetKey)
    if (entry === undefined) throw new FsError('not found', 'FS_NOT_FOUND')
    return entry.content
  }

  async writeText(target: FsTarget, content: string, expected?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }): Promise<{ operation: 'create' | 'update'; version: FsVersion; after: string }> {
    const existing = this.files.get(target.targetKey)
    if (expected?.kind === 'createIfAbsent') {
      if (existing !== undefined) throw new FsError('exists', 'FS_NOT_OBSERVED')
      const version = String(this.counter++) as FsVersion
      this.files.set(target.targetKey, { content, version: Number(version) })
      return { operation: 'create', version, before: null, after: content }
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || String(existing.version) !== expected.version) {
        throw new FsError('stale', 'FS_STALE_VERSION')
      }
      const version = String(this.counter++) as FsVersion
      this.files.set(target.targetKey, { content, version: Number(version) })
      return { operation: 'update', version, before: existing?.content ?? null, after: content }
    }
    const version = String(this.counter++) as FsVersion
    this.files.set(target.targetKey, { content, version: Number(version) })
    return { operation: existing === undefined ? 'create' : 'update', version, before: existing?.content ?? null, after: content }
  }
}

function fakeAgent(cwd: string, suffix = ''): Agent {
  return {
    id: `agent-${cwd}${suffix}` as never,
    session: { header: { cwd } } as never,
    ctx: {} as never,
    options: {} as never,
  } as unknown as Agent
}

function readSidecar(fs: FakeFs, cwd: string, name: string): string {
  const entry = fs.files.get(`${cwd}/.cicada/${name}`)
  return entry?.content ?? ''
}

describe('turn session (9-impl §2.5: native CAS, oplog, transaction)', () => {
  it('detects an external edit once and advances the persisted baseline', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format, { watch: () => ({ on: () => {}, close: () => {} } as never) })
    const agent = fakeAgent('/ws')

    await manager.perform(agent, { tool: 'place_symbol', args: { refdes: 'R1' } }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return undefined
    })
    await manager.commit(agent)

    const target = await fs.resolve('.cicada/schematic.cicada_sch', { cwd: '/ws' })
    await fs.writeText(target, readSidecar(fs, '/ws', 'schematic.cicada_sch').replace('10k', '4.7k'))

    const first = await manager.reconcileWorkspace('/ws')
    expect(first?.entries).toHaveLength(1)
    expect(first?.entries[0]).toMatchObject({ type: 'user_edit', summary: 'R1 值 10k → 4.7k' })
    const changelog = readSidecar(fs, '/ws', 'changelog.jsonl')
    expect(changelog.match(/user_edit/g)).toHaveLength(1)

    const second = await manager.reconcileWorkspace('/ws')
    expect(second).toBeUndefined()
    expect(readSidecar(fs, '/ws', 'changelog.jsonl').match(/user_edit/g)).toHaveLength(1)
    expect(JSON.parse(readSidecar(fs, '/ws', 'view.json')).baselineVersion).toBeDefined()
  })

  it('advances a baseline for a no-op dialogue without appending a user edit', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format, { watch: () => ({ on: () => {}, close: () => {} } as never) })
    const agent = fakeAgent('/ws')
    await manager.perform(agent, { tool: 'place_symbol', args: { refdes: 'R1' } }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return undefined
    })
    await manager.commit(agent)
    const before = readSidecar(fs, '/ws', 'changelog.jsonl')
    const result = await manager.advanceBaseline('/ws')
    expect(result).toBeUndefined()
    expect(readSidecar(fs, '/ws', 'changelog.jsonl')).toBe(before)
  })

  it('recovers from a corrupt baseline cache and rebuilds it from the file', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format)
    const agent = fakeAgent('/ws')
    await manager.perform(agent, { tool: 'place_symbol', args: {} }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return undefined
    })
    await manager.commit(agent)

    const baseline = await fs.resolve('.cicada/view.json', { cwd: '/ws' })
    await fs.writeText(baseline, '{not-json')
    const result = await manager.reconcileWorkspace('/ws')
    expect(result?.entries).toEqual([])
    expect(JSON.parse(readSidecar(fs, '/ws', 'view.json')).components).toHaveLength(1)
  })

  it('seeds the schematic, commits one op, and flushes oplog + changelog + view.json', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format)
    const agent = fakeAgent('/ws')

    await manager.perform(agent, { tool: 'place_symbol', args: { refdes: 'R1' } }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return model.file.symbols.length
    })
    await manager.commit(agent)

    const schematic = readSidecar(fs, '/ws', 'schematic.cicada_sch')
    expect(schematic).toContain('(symbol (lib_id "cicada:R")')
    expect(schematic).toContain('"R1"')
    const oplog = readSidecar(fs, '/ws', 'oplog.jsonl')
    expect(oplog).toContain('"tool":"place_symbol"')
    const changelog = readSidecar(fs, '/ws', 'changelog.jsonl')
    expect(changelog).toContain('ai_op')
    const view = JSON.parse(readSidecar(fs, '/ws', 'view.json'))
    expect(view.components).toHaveLength(1)
  })

  it('raises expected_net_mismatch when the file changed under the turn (native CAS)', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format)
    const agent = fakeAgent('/ws')

    await manager.perform(agent, { tool: 'place_symbol', args: {} }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return undefined
    })
    // External writer bumps the version.
    const target = await fs.resolve('.cicada/schematic.cicada_sch', { cwd: '/ws' })
    await fs.writeText(target, readSidecar(fs, '/ws', 'schematic.cicada_sch') + '\n')

    const error = await manager.commit(agent).then(() => undefined, (value: unknown) => value)
    expect((error as { code?: string }).code).toBe('expected_net_mismatch')
    // The turn auto-resets from disk; the producer re-reads and retries.
    await manager.perform(agent, { tool: 'place_symbol', args: {} }, (model) => {
      model.file.symbols.push({
        libId: 'cicada:R', at: { x: 2540, y: 2540 }, rotation: 0, unit: 1, uuid: 'u',
        properties: { Reference: 'R2', Value: '4.7k', Footprint: '', Datasheet: '' },
        pins: [{ number: '1', uuid: 'p1' }, { number: '2', uuid: 'p2' }],
      })
      return undefined
    })
    await manager.commit(agent)
    expect(readSidecar(fs, '/ws', 'schematic.cicada_sch')).toContain('"R2"')
  })

  it('rolls back a failed op: no partial file, no oplog, commit is a no-op', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format)
    const agent = fakeAgent('/ws')

    await manager.perform(agent, { tool: 'place_symbol', args: {} }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return undefined
    })
    await expect(manager.perform(agent, { tool: 'place_symbol', args: {} }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: 'dup', kind: 'sym2' }, {})
      return undefined
    })).rejects.toMatchObject({ code: 'duplicate_refdes' })
    await manager.commit(agent)

    expect(readSidecar(fs, '/ws', 'schematic.cicada_sch')).not.toContain('"dup"')
    const oplog = readSidecar(fs, '/ws', 'oplog.jsonl')
    expect(oplog.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('serializes concurrent turns on one workspace via the process mutex', async () => {
    const fs = new FakeFs()
    const manager = new TurnManager(fs, format)
    const a = fakeAgent('/ws')
    const b = fakeAgent('/ws', '-b')

    await manager.perform(a, { tool: 'place_symbol', args: {} }, (model) => {
      placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
      return undefined
    })
    // Second agent on the same workspace blocks until the first commits.
    let second: Promise<unknown> | undefined
    const waiter = manager.perform(b, { tool: 'place_symbol', args: {} }, (model) => {
      placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, {})
      return undefined
    }).then(() => undefined)
    second = waiter
    await manager.commit(a)
    await second
    await manager.commit(b)
    const schematic = readSidecar(fs, '/ws', 'schematic.cicada_sch')
    expect(schematic).toContain('"R1"')
    expect(schematic).toContain('"C1"')
  })
})
