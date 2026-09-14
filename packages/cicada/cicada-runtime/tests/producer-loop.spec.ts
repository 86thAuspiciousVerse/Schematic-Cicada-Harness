import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as CicadaFormat from '@deepseek-ai/dsh-cicada-format'
import * as CicadaDeriver from '@deepseek-ai/dsh-cicada-deriver'
import * as CicadaKnowledge from '@deepseek-ai/dsh-cicada-knowledge'
import * as CicadaRuntime from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  if (agent.status === 'idle') return
  await new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function finalText(agent: Agent): string {
  const message = [...agent.session.events].findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function runtimeEditMessages(agent: Agent): string[] {
  return [...agent.session.events]
    .filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-cicada-runtime')
    .map(event => event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(''))
}

/** Poll `check` until it yields a value (undefined = keep waiting). */
async function waitUntil<T>(check: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Poll until the agent's last assistant message contains `needle`. */
async function waitForText(agent: Agent, needle: string, timeoutMs = 15_000): Promise<void> {
  await waitUntil(() => (finalText(agent).includes(needle) ? true : undefined), `${needle} in the main agent's reply`, timeoutMs)
}

/** Poll until the workspace file carries `needle` (producers commit at turn end). */
async function waitForFile(path: string, needle: string, timeoutMs = 15_000): Promise<string> {
  return await waitUntil(async () => {
    try {
      const text = await readFile(path, 'utf8')
      return text.includes(needle) ? text : undefined
    } catch {
      return undefined // not written yet
    }
  }, `${needle} in ${path}`, timeoutMs)
}

/** How many changelog rows of one type the workspace has recorded. */
async function changelogCount(workspace: string, type: string): Promise<number> {
  return (await readChangelog(workspace)).filter(entry => entry.type === type).length
}

async function readChangelog(workspace: string): Promise<Array<{ type: string; summary: string }>> {
  try {
    const text = await readFile(join(workspace, '.cicada', 'changelog.jsonl'), 'utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; summary: string })
  } catch {
    return []
  }
}

/**
 * Minimal `sessionQuery` for the continuation path: cold resume only observes
 * one persisted child, and the base engine implements that over the session
 * store — the two search methods are the abstract surface (same double the
 * other continuation suites use).
 */
class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    ..._args: Parameters<SessionQueryEngine['searchSessions']>
  ): ReturnType<SessionQueryEngine['searchSessions']> {
    return Promise.resolve({ items: [] })
  }

  override searchEvents(
    ...args: Parameters<SessionQueryEngine['searchEvents']>
  ): ReturnType<SessionQueryEngine['searchEvents']> {
    return this.readSurface(args[0].sessionId).then(surface => ({
      session: surface.session,
      items: [],
    }))
  }
}

describe('real AgentLoop producer schematic closure', () => {
  let ctx: Context | undefined
  let workspace: string | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
    workspace = undefined
  })

  it('M1e-1 auto-resolves a missing lib_id from workspace shape.json (engine synthesis, runtime-internal)', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-m1e-auto-'))
    // 形状块文件：自动查缺源（docs/09 §5；优先拍板）
    await mkdir(join(workspace, 'datasheet', 'AMS1117'), { recursive: true })
    await writeFile(
      join(workspace, 'datasheet', 'AMS1117', 'shape.json'),
      JSON.stringify({
        name: 'AMS1117',
        refPrefix: 'U',
        pins: [
          { number: '1', name: 'GND', electrical: 'power_in', side: 'bottom' },
          { number: '2', name: 'VOUT', electrical: 'power_out', side: 'right' },
          { number: '3', name: 'VIN', electrical: 'power_in', side: 'left' },
        ],
      }),
      'utf8',
    )
    let synthesizeCalls = 0
    let synthesizeBlock: { name?: string } | undefined
    let synthesized = false
    const engine = {
      async listSymbols(): Promise<string[]> { return ['R'] },
      async listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]> {
        return [{ libId: 'R:R', name: 'R', category: 'R', pins: 2 }]
      },
      async getSymbol(key: string): Promise<{
        libId: string
        name: string
        pins: { number: string; name: string; x: number; y: number; angle: number }[]
      } | undefined> {
        if (key === 'IC:AMS1117') {
          if (!synthesized) return undefined
          return {
            libId: 'IC:AMS1117',
            name: 'AMS1117',
            pins: [
              { number: '1', name: 'GND', x: 0, y: -38100, angle: 90 },
              { number: '2', name: 'VOUT', x: 38100, y: 0, angle: 180 },
              { number: '3', name: 'VIN', x: -38100, y: 0, angle: 0 },
            ],
          }
        }
        return undefined
      },
      async synthesize(block: { name?: string }): Promise<{ ok: boolean; libId?: string }> {
        synthesizeCalls += 1
        synthesizeBlock = block
        synthesized = true
        return { ok: true, libId: `IC:${block.name ?? ''}` }
      },
      async setDocument(): Promise<{ ok: boolean }> { return { ok: true } },
    }

    const adapter = new MockAdapter([
      toolCallResponse('spawn-1', 'spawn_producer', {
        description: 'Create the requested AMS1117 regulator placement.',
        prompt: 'Place U1=AMS1117-3.3 via lib_id=IC:AMS1117.',
        run_in_background: false,
      }),
      toolCallResponse('place-u1', 'place_symbol', {
        refdes: 'U1', value: 'AMS1117-3.3', lib_id: 'IC:AMS1117', source_ids: [],
      }),
      textResponse('PRODUCER_AMS1117_DONE'),
      textResponse('MAIN_AMS1117_DONE'),
    ])

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.provide('cicadaEngineClient', engine)
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer. Use only the schematic write tools.',
    })

    const agent = ctx.agentLoop.create(SessionId('cicada-m1e-loop'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Place the AMS1117 regulator described by the producer task.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    expect(synthesizeCalls).toBe(1)
    expect(synthesizeBlock?.name).toBe('AMS1117')
    const schematic = await readFile(join(workspace, '.cicada', 'schematic.cicada_sch'), 'utf8')
    expect(schematic).toContain('(symbol "IC:AMS1117"')
    expect(schematic).not.toContain('cicada:')
    const parsed = ctx.cicadaFormat.parse(schematic)
    expect(parsed.symbols.map((symbol) => symbol.properties.Reference)).toContain('U1')
    expect(parsed.libSymbols.find(entry => entry.libId === 'IC:AMS1117')?.pins.map(pin => pin.number)).toEqual(['1', '2', '3'])
    expect(finalText(agent)).toContain('MAIN_AMS1117_DONE')
  }, 30_000)

  it('synthesizes under the REQUESTED part number when the shape block names another part', async () => {
    // 缺陷 4（2026-09-13）：实测 datasheet/AMS1117-3.3/shape.json 写着 name=AMS1117，引擎
    // 便按其铸出 IC:AMS1117 去顶撞同名条目。目录/请求键才是件的权威，块内 name 只是建议。
    workspace = await mkdtemp(join(tmpdir(), 'cicada-m1e-blockname-'))
    await mkdir(join(workspace, 'datasheet', 'AMS1117-3.3'), { recursive: true })
    await writeFile(
      join(workspace, 'datasheet', 'AMS1117-3.3', 'shape.json'),
      JSON.stringify({
        name: 'AMS1117',
        refPrefix: 'U',
        pins: [{ number: '1', name: 'GND', electrical: 'power_in', side: 'bottom' }],
      }),
      'utf8',
    )
    let synthesizeBlock: { name?: string } | undefined
    let synthesized = false
    const engine = {
      async listSymbols(): Promise<string[]> { return ['R'] },
      async listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]> { return [] },
      async getSymbol(key: string): Promise<{
        libId: string
        name: string
        pins: { number: string; name: string; x: number; y: number; angle: number }[]
      } | undefined> {
        if (key !== 'IC:AMS1117-3.3' || !synthesized) return undefined
        return { libId: key, name: 'AMS1117-3.3', pins: [{ number: '1', name: 'GND', x: 0, y: -38100, angle: 90 }] }
      },
      async synthesize(block: { name?: string }): Promise<{ ok: boolean; libId?: string }> {
        synthesizeBlock = block
        synthesized = true
        return { ok: true, libId: `IC:${block.name ?? ''}` }
      },
      async setDocument(): Promise<{ ok: boolean }> { return { ok: true } },
    }
    const adapter = new MockAdapter([
      toolCallResponse('spawn-1', 'spawn_producer', {
        description: 'Place the requested regulator.',
        prompt: 'Place U1=AMS1117-3.3 via lib_id=IC:AMS1117-3.3.',
        run_in_background: false,
      }),
      toolCallResponse('place-u1', 'place_symbol', {
        refdes: 'U1', value: 'AMS1117-3.3', lib_id: 'IC:AMS1117-3.3', source_ids: [],
      }),
      textResponse('PRODUCER_BLOCKNAME_DONE'),
      textResponse('MAIN_BLOCKNAME_DONE'),
    ])
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.provide('cicadaEngineClient', engine)
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer. Use only the schematic write tools.',
    })
    const agent = ctx.agentLoop.create(SessionId('cicada-m1e-blockname'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Place the AMS1117-3.3 regulator described by the producer task.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    expect(synthesizeBlock?.name).toBe('AMS1117-3.3')
    const schematic = await readFile(join(workspace, '.cicada', 'schematic.cicada_sch'), 'utf8')
    expect(schematic).toContain('(symbol "IC:AMS1117-3.3"')
    expect(finalText(agent)).toContain('MAIN_BLOCKNAME_DONE')
  }, 30_000)

  it('docs/05 §1: a human-held editor lock refuses the producer write (editor_busy, nothing written)', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-editor-lock-'))
    const engine = {
      async listSymbols(): Promise<string[]> { return ['R'] },
      async listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]> {
        return [{ libId: 'R:R', name: 'R', category: 'R', pins: 2 }]
      },
      async getSymbol(key: string): Promise<{
        libId: string
        name: string
        pins: { number: string; name: string; x: number; y: number; angle: number }[]
      } | undefined> {
        if (key !== 'R:R') return undefined
        return { libId: 'R:R', name: 'R', pins: [
          { number: '1', name: '~', x: 0, y: 25400, angle: 270 },
          { number: '2', name: '~', x: 0, y: -25400, angle: 90 },
        ] }
      },
      async synthesize(): Promise<{ ok: boolean; error?: string }> {
        return { ok: false, error: 'not used in this case' }
      },
      async setDocument(): Promise<{ ok: boolean }> { return { ok: true } },
    }
    const lock = {
      acquireAgent: vi.fn(),
      releaseAgent: vi.fn(),
      canAgentWrite: vi.fn(() => false),
    }
    const adapter = new MockAdapter([
      toolCallResponse('spawn-lock', 'spawn_producer', {
        description: 'Place R1 while the human holds the canvas.',
        prompt: 'Place R1 = 10k via lib_id=R:R.',
        run_in_background: false,
      }),
      toolCallResponse('place-r1', 'place_symbol', {
        refdes: 'R1', value: '10k', lib_id: 'R:R', source_ids: [],
      }),
      textResponse('PRODUCER_REFUSED'),
      textResponse('MAIN_REFUSED_DONE'),
    ])

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.provide('cicadaEngineClient', engine)
    ctx.provide('cicadaEditorLock', lock as never)
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer.',
    })

    const agent = ctx.agentLoop.create(SessionId('cicada-editor-lock'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Place R1.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // The lock is taken for the turn and released after the commit.
    expect(lock.acquireAgent).toHaveBeenCalled()
    expect(lock.releaseAgent).toHaveBeenCalled()
    // Nothing reached the schematic: the write tool was refused at the entry.
    const schematic = await readFile(join(workspace, '.cicada', 'schematic.cicada_sch'), 'utf8').catch(() => '')
    expect(schematic).not.toContain('R1')
    expect(finalText(agent)).toContain('MAIN_REFUSED_DONE')
  }, 30_000)

  it('M1b 库道：catalog keys place and their pins resolve for connect_pins', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-lib-lane-'))
    const engine = {
      async listSymbols(): Promise<string[]> { return ['R', 'C_Small'] },
      async listLibrary(): Promise<{ libId: string; name: string; category: string; pins: number }[]> {
        return [
          { libId: 'R:R', name: 'R', category: 'R', pins: 2 },
          { libId: 'C:C_Small', name: 'C_Small', category: 'C', pins: 2 },
        ]
      },
      async getSymbol(key: string): Promise<{
        libId: string
        name: string
        pins: { number: string; name: string; x: number; y: number; angle: number }[]
      } | undefined> {
        if (key === 'R:R') {
          return { libId: 'R:R', name: 'R', pins: [
            { number: '1', name: '~', x: 0, y: 25400, angle: 270 },
            { number: '2', name: '~', x: 0, y: -25400, angle: 90 },
          ] }
        }
        if (key === 'C:C_Small') {
          return { libId: 'C:C_Small', name: 'C_Small', pins: [
            { number: '1', name: '', x: 0, y: 25400, angle: 270 },
            { number: '2', name: '', x: 0, y: -25400, angle: 90 },
          ] }
        }
        return undefined
      },
      async synthesize(): Promise<{ ok: boolean; error?: string }> {
        return { ok: false, error: 'synthesis is not part of this case' }
      },
      async setDocument(): Promise<{ ok: boolean }> { return { ok: true } },
    }

    const adapter = new MockAdapter([
      toolCallResponse('spawn-1', 'spawn_producer', {
        description: 'Place the resistor and capacitor from the library catalog.',
        prompt: 'Place R1=R:R and C1=C:C_Small, then connect R1.2 to C1.1.',
        run_in_background: false,
      }),
      toolCallResponse('place-r1', 'place_symbol', {
        refdes: 'R1', value: '10k', lib_id: 'R:R', source_ids: [],
      }),
      toolCallResponse('place-c1', 'place_symbol', {
        refdes: 'C1', value: '100nF', lib_id: 'C:C_Small', source_ids: [],
      }),
      toolCallResponse('connect-rc', 'connect_pins', {
        endpoints: [['R1.2', 'C1.1']],
      }),
      textResponse('PRODUCER_LIB_LANE_DONE'),
      textResponse('MAIN_LIB_LANE_DONE'),
    ])

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.provide('cicadaEngineClient', engine)
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer. Use only the schematic write tools.',
    })

    const agent = ctx.agentLoop.create(SessionId('cicada-lib-lane'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the R1/C1 circuit from the library catalog.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const schematic = await readFile(join(workspace, '.cicada', 'schematic.cicada_sch'), 'utf8')
    // 文件层键化（docs/09 §1）：条目与实例都写引擎规范键，不再伪造 `cicada:` 前缀。
    expect(schematic).toContain('(symbol "R:R"')
    expect(schematic).toContain('(symbol "C:C_Small"')
    expect(schematic).not.toContain('cicada:')
    const parsed = ctx.cicadaFormat.parse(schematic)
    expect(parsed.libSymbols.find(entry => entry.libId === 'C:C_Small')?.pins.map(pin => pin.number)).toEqual(['1', '2'])
    expect(parsed.symbols.map(symbol => symbol.libId)).toEqual(expect.arrayContaining(['R:R', 'C:C_Small']))
    // connect_pins 按 refdes.pin-number 命中库引脚 → 真的产生了 wire。
    expect(parsed.wires.length).toBeGreaterThan(0)
    expect(finalText(agent)).toContain('MAIN_LIB_LANE_DONE')
  }, 30_000)

  it('delegates to producer tools, commits .cicada_sch, and derives the expected nets', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-producer-loop-'))
    const adapter = new MockAdapter([
      toolCallResponse('spawn-1', 'spawn_producer', {
        description: 'Create the requested minimal resistor circuit.',
        prompt: 'Place R1=10k, C1=100nF and a GND power symbol. Connect R1.2 to C1.1 and C1.2 to GND.',
        run_in_background: false,
      }),
      toolCallResponse('place-r1', 'place_symbol', {
        refdes: 'R1', value: '10k', kind: 'sym2', source_ids: [],
      }),
      toolCallResponse('place-c1', 'place_symbol', {
        refdes: 'C1', value: '100nF', kind: 'sym2', source_ids: [],
      }),
      toolCallResponse('connect-rc', 'connect_pins', {
        endpoints: [['R1.2', 'C1.1']],
      }),
      toolCallResponse('power-gnd', 'place_power_symbol', {
        name: 'GND', endpoint: 'C1.2',
      }),
      textResponse('PRODUCER_CIRCUIT_DONE'),
      textResponse('MAIN_CIRCUIT_DONE'),
    ])

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer. Use only the schematic write tools.',
    })

    const agent = ctx.agentLoop.create(SessionId('cicada-main-loop'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the minimal R1/C1/GND circuit described by the producer task.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const calls = [...agent.session.events]
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.name)
    expect(calls).toContain('spawn_producer')
    const schematicPath = join(workspace, '.cicada', 'schematic.cicada_sch')
    const schematic = await readFile(schematicPath, 'utf8')
    const parsed = ctx.cicadaFormat.parse(schematic)
    const derived = ctx.cicadaDeriver.derive(parsed)
    expect(parsed.symbols.map(symbol => symbol.properties.Reference)).toEqual(expect.arrayContaining(['R1', 'C1', '#PWR01']))
    expect(derived.nets).toEqual(expect.arrayContaining([
      expect.objectContaining({ members: expect.arrayContaining([
        expect.objectContaining({ refdes: 'R1', physicalNumber: '2' }),
        expect.objectContaining({ refdes: 'C1', physicalNumber: '1' }),
      ]) }),
      expect.objectContaining({ name: 'GND', members: expect.arrayContaining([
        expect.objectContaining({ refdes: 'C1', physicalNumber: '2' }),
      ]) }),
    ]))
    expect(finalText(agent)).toContain('MAIN_CIRCUIT_DONE')
  }, 30_000)

  it('performs the P7/G7 end-to-end edit handoff: one reminder on the next dialogue only', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-p7-g7-e2e-'))
    const adapter = new MockAdapter([
      toolCallResponse('spawn-1', 'spawn_producer', {
        description: 'Create the requested minimal resistor circuit.',
        prompt: 'Place R1=10k and C1=100nF. Connect R1.2 to C1.1.',
        run_in_background: false,
      }),
      toolCallResponse('place-r1', 'place_symbol', {
        refdes: 'R1', value: '10k', kind: 'sym2', source_ids: [],
      }),
      toolCallResponse('place-c1', 'place_symbol', {
        refdes: 'C1', value: '100nF', kind: 'sym2', source_ids: [],
      }),
      toolCallResponse('connect-rc', 'connect_pins', {
        endpoints: [['R1.2', 'C1.1']],
      }),
      textResponse('PRODUCER_EDIT_HANDOFF_DONE'),
      textResponse('MAIN_EDIT_HANDOFF_DONE'),
      textResponse('SECOND_DIALOGUE_DONE'),
      textResponse('THIRD_DIALOGUE_DONE'),
    ])

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer. Use only the schematic write tools.',
    })

    const agent = ctx.agentLoop.create(SessionId('cicada-p7-g7-loop'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the minimal R1/C1 circuit.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const schematicPath = join(workspace, '.cicada', 'schematic.cicada_sch')
    const initial = await readFile(schematicPath, 'utf8')
    expect(initial).toContain('10k')
    const parsed = ctx.cicadaFormat.parse(initial)
    expect(ctx.cicadaDeriver.derive(parsed).nets).toEqual(expect.arrayContaining([
      expect.objectContaining({ members: expect.arrayContaining([
        expect.objectContaining({ refdes: 'R1', physicalNumber: '2' }),
        expect.objectContaining({ refdes: 'C1', physicalNumber: '1' }),
      ]) }),
    ]))

    // Simulate an editor/user write outside the runtime transaction.
    await writeFile(schematicPath, initial.replace('10k', '4.7k'), 'utf8')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue after checking the current drawing.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    const afterSecond = runtimeEditMessages(agent)
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]).toContain('检测到画布或文件被手工修改')
    expect(afterSecond[0]).toContain('R1 值 10k → 4.7k')

    const changelogAfterSecond = await readChangelog(workspace)
    const userEditsAfterSecond = changelogAfterSecond.filter(entry => entry.type === 'user_edit')
    expect(userEditsAfterSecond).toHaveLength(1)
    expect(userEditsAfterSecond[0]?.summary).toBe('R1 值 10k → 4.7k')
    const baselineAfterSecond = JSON.parse(await readFile(join(workspace, '.cicada', 'view.json'), 'utf8')) as { baselineVersion?: string }
    expect(baselineAfterSecond.baselineVersion).toBeDefined()

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Please summarize the current drawing.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    expect(runtimeEditMessages(agent)).toHaveLength(1)
    expect((await readChangelog(workspace)).filter(entry => entry.type === 'user_edit')).toHaveLength(1)
    expect(finalText(agent)).toContain('THIRD_DIALOGUE_DONE')
  }, 30_000)

  it('docs/05 §8: keeps ONE long-lived producer and continues it with send_message', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-producer-long-'))
    const schematicPath = join(workspace, '.cicada', 'schematic.cicada_sch')
    const adapter = new MockAdapter([
      // producer turn 1 (dispatched in the background, the pipeline default)
      toolCallResponse('place-r1', 'place_symbol', { refdes: 'R1', value: '10k', kind: 'sym2', source_ids: [] }),
      textResponse('PRODUCER_TURN1_DONE'),
      // the orchestrator wakes on the child's completion notice (no polling)
      textResponse('MAIN_NOTICE_1'),
      // producer turn 2 (after the orchestrator's follow-up message)
      toolCallResponse('place-c1', 'place_symbol', { refdes: 'C1', value: '100nF', kind: 'sym2', source_ids: [] }),
      textResponse('PRODUCER_TURN2_DONE'),
      textResponse('MAIN_NOTICE_2'),
    ])

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    // Continuable children require a session-persistence backend (the product
    // host loads one; the other producer cases run the one-shot start path).
    await ctx.plugin(JsonlSessionPersistence, { root: join(workspace, '.sessions') })
    // …and the observation used to resume the child when the next order arrives.
    await ctx.plugin(TestSessionQueryEngine)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer. Use only the schematic write tools.',
    })
    await ctx.plugin(ToolSubagentControl)

    const main = ctx.agentLoop.create(SessionId('cicada-long-producer'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const exec = { agent: main, signal: new AbortController().signal } as never

    // The pipeline spawns the producer once: the call returns a durable id at
    // once and the child owns its own conversation from there.
    const spawn = ctx.tools.get('spawn_producer')
    expect(spawn).toBeDefined()
    const started = await spawn!.execute({ description: 'Build R1', prompt: 'Place R1=10k.' }, exec) as { kind: string; subagentId: string }
    expect(started.kind).toBe('continuable')
    await waitForFile(schematicPath, '10k')

    // It is not torn down with the run: the durable id addresses one
    // conversation, resumed from persistence whenever the next order arrives.
    const childId = SessionId(started.subagentId)

    // The user asks for a change: the orchestrator messages the SAME producer
    // (this is exactly the call the `send_message` tool makes).
    // The completion notice reaches the orchestrator on its own: the main agent
    // runs a turn for it, so it can report without polling the child.
    await waitForText(main, 'MAIN_NOTICE_1')

    // The user asks for a change: the orchestrator messages the SAME producer
    // (this is exactly the call the `send_message` tool makes).
    const send = ctx.tools.get('send_message')
    expect(send).toBeDefined()
    await send!.execute({ subagent_id: started.subagentId, message: 'Also place C1=100nF.' }, exec)

    // Same child, next turn: the earlier work survives and the new part lands.
    const schematic = await waitForFile(schematicPath, '100nF')
    expect(schematic).toContain('10k')
    expect(ctx.cicadaFormat.parse(schematic).symbols.map(symbol => symbol.properties.Reference))
      .toEqual(expect.arrayContaining(['R1', 'C1']))
    await waitUntil(async () => ((await changelogCount(workspace, 'ai_op')) >= 2 ? true : undefined), 'two committed ai_op rows')

    // …and it is the SAME conversation: the child's persisted session still
    // carries the first turn, so the producer's context and build history are
    // intact (the live handle is released between turns by design).
    await waitUntil(() => (ctx.get('agents')?.get(childId) === undefined ? true : undefined), 'the producer turn to close')
    const persisted = await ctx.sessionPersistence.load(childId)
    const toolCalls = persisted.events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(toolCalls).toContain('place_symbol')
    await waitForText(main, 'MAIN_NOTICE_2')
  }, 30_000)
})
