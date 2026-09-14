import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as CicadaFormat from '@deepseek-ai/dsh-cicada-format'
import * as CicadaDeriver from '@deepseek-ai/dsh-cicada-deriver'
import * as CicadaKnowledge from '@deepseek-ai/dsh-cicada-knowledge'
import * as CicadaRuntime from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Same minimal `sessionQuery` the other continuation suites use. */
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

const KNOWLEDGE_PERSONA = 'You are the Schematic-Cicada knowledge agent: you write `.cicada/design_intent.json`.'
const DATASHEET_PERSONA = 'You are the Schematic-Cicada datasheet agent: you write index.json, detail/<group_id>.json and shape.json.'

describe('role dispatch tools (docs/05 §8)', () => {
  let ctx: Context | undefined
  let workspace: string | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
    workspace = undefined
  })

  it('starts continuable children whose system prompt carries the role persona', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-roles-'))
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('KNOWLEDGE_DONE'), textResponse('DATASHEET_DONE')]))
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    // Continuable children require persistence + the query service (product host).
    await ctx.plugin(JsonlSessionPersistence, { root: join(workspace, '.sessions') })
    await ctx.plugin(TestSessionQueryEngine)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      toolName: 'spawn_knowledge',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: KNOWLEDGE_PERSONA,
    })
    await ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      toolName: 'spawn_datasheet',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: DATASHEET_PERSONA,
    })

    const main = ctx.agentLoop.create(SessionId('cicada-roles-main'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const exec = { agent: main, signal: new AbortController().signal } as never

    /** Run one role tool and return the child's persisted system prompt. */
    const dispatch = async (toolName: string, prompt: string, marker: string): Promise<string> => {
      const tool = ctx!.tools.get(toolName)
      expect(tool, `${toolName} is registered`).toBeDefined()
      const started = await tool!.execute({ description: 'role dispatch', prompt }, exec) as { kind: string; subagentId: string }
      expect(started.kind).toBe('continuable')
      const childId = SessionId(started.subagentId)
      // The child is materialized, runs its turn, and is released between
      // turns; wait until its persisted session carries the model request.
      const persisted = await vi.waitFor(async () => {
        const loaded = await ctx!.sessionPersistence.load(childId)
        expect(loaded.events.some(event => event.type === 'request/header')).toBe(true)
        return loaded
      }, { timeout: 15_000 })
      const header = persisted.events.find(event => event.type === 'request/header')
      const system = header?.type === 'request/header'
        ? (header.data as { header?: { system?: string } }).header?.system ?? ''
        : ''
      expect(system).toContain(marker)
      // The child conversation is addressable by the same durable id afterwards.
      expect(persisted.meta.id).toBe(childId)
      return system
    }

    const knowledge = await dispatch('spawn_knowledge', 'Clarify the STM32 minimum system board.', 'Schematic-Cicada knowledge agent')
    expect(knowledge).toContain('design_intent.json')
    const datasheet = await dispatch('spawn_datasheet', 'Extract AMS1117-3.3 from full.md.', 'Schematic-Cicada datasheet agent')
    expect(datasheet).toContain('shape.json')
  }, 30_000)


  it('starts a continuable producer child that carries the eight write tools', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-producer-role-'))
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('PRODUCER_DONE')]))
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace, '.cicada-data') })
    await ctx.plugin(CicadaRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(JsonlSessionPersistence, { root: join(workspace, '.sessions') })
    await ctx.plugin(TestSessionQueryEngine)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    // Same rows the shipped cicada preset mounts (provider + tool instance).
    await ctx.plugin(SpawnInProcess, { providerName: 'cicada-producer' })
    await ctx.plugin(ToolSubagent, {
      provider: 'cicada-producer',
      toolName: 'spawn_producer',
      backgroundMode: 'continuable',
      maxDepth: 1,
      persona: 'You are the Schematic-Cicada producer.',
    })

    const main = ctx.agentLoop.create(SessionId('cicada-producer-role-main'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const spawn = ctx.tools.get('spawn_producer')
    expect(spawn, 'the producer dispatch tool is registered').toBeDefined()
    const started = await spawn!.execute(
      { description: 'draw', prompt: 'Place R1.' },
      { agent: main, signal: new AbortController().signal } as never,
    ) as { kind: string; subagentId: string }
    expect(started.kind).toBe('continuable')

    const childId = SessionId(started.subagentId)
    const persisted = await vi.waitFor(async () => {
      const loaded = await ctx!.sessionPersistence.load(childId)
      expect(loaded.events.some(event => event.type === 'request/header')).toBe(true)
      return loaded
    }, { timeout: 15_000 })
    const header = persisted.events.find(event => event.type === 'request/header')
    const tools = header?.type === 'request/header'
      ? ((header.data as { header?: { tools?: { name?: string }[] } }).header?.tools ?? []).map(tool => tool.name)
      : []
    // The producer role injection (roles.ts) put the write tools in its scope…
    expect(tools).toEqual(expect.arrayContaining(['place_symbol', 'connect_pins', 'place_power_symbol']))
    // …and the main-only / spawn family stays hidden from the child.
    expect(tools).not.toContain('spawn_producer')
    expect(tools).not.toContain('datasheet_library_check')
  }, 30_000)

  it('keeps the shipped cicada preset carrying all three role tools as continuable personas', () => {
    const preset = readFileSync(join(import.meta.dirname, '..', '..', '..', 'preset', 'agent-presets', 'presets', 'cicada', 'agent.cordis.yml'), 'utf8')
    /** One row's text: from its `- id:` up to the next row (never across rows). */
    const rowOf = (id: string): string => {
      const at = preset.indexOf(`- id: ${id}\n`)
      expect(at, `${id} is declared in the preset`).toBeGreaterThanOrEqual(0)
      const next = preset.indexOf('\n    - id: ', at + 1)
      return preset.slice(at, next < 0 ? undefined : next)
    }

    for (const [row, toolName] of [
      ['tool-subagent-knowledge', 'spawn_knowledge'],
      ['tool-subagent-datasheet', 'spawn_datasheet'],
      ['tool-subagent-producer', 'spawn_producer'],
    ] as const) {
      const block = rowOf(row)
      expect(block, `${toolName} is the row's tool`).toContain(`toolName: ${toolName}`)
      expect(block, `${toolName} runs continuable children`).toContain('backgroundMode: continuable')
      expect(block, `${toolName} cannot spawn grandchildren`).toContain('maxDepth: 1')
      expect(block, `${toolName} carries a role persona`).toContain('persona: >-')
      // A role row must say what it dispatches: the generic wording is identical
      // for every instance, which left the model unable to tell the roles apart
      // (measured 2026-09-13).
      expect(block, `${toolName} carries a role description`).toContain('toolDescription: >-')
      // And no child may inherit the orchestrator's lane: no shared-library
      // query/copy/publish, no MinerU, no delegation.
      expect(block, `${toolName} restricts the child tool surface`).toContain('toolFilter:')
      // `subagent` is not on the list: the provider registers it in the child's
      // own scope, which restrict() does not filter; `maxDepth: 1` refuses the
      // call instead (asserted above).
      for (const denied of ['datasheet_library_check', 'datasheet_library_copy', 'datasheet_library_publish', 'mineru_extract', "'subagent_fork'", "'spawn_producer'"]) {
        expect(block, `${toolName} denies ${denied}`).toContain(denied)
      }
    }
    // The producer additionally cannot write files directly (its artifacts are
    // the datasheet three-piece set, which belongs to the datasheet lane).
    expect(rowOf('tool-subagent-producer')).toContain("'write'")
    // Fork children are capped like the role rows (docs/05 §8-3: no grandchildren).
    expect(rowOf('tool-subagent-fork')).toContain('maxDepth: 1')
  })
})
