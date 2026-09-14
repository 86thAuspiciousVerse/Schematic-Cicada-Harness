import { describe, expect, it } from 'vitest'

import type { Agent } from '@deepseek-ai/dsh-agent'

import { PRODUCER_DENY, descriptorOf, installScopedTools, isKnowledge, isProducer, knowledgeDatasheetReadDenial, landscapeWriteDenial } from '../src/roles.ts'

function agentWithEvents(events: unknown[]): Agent {
  return { session: { events } } as unknown as Agent
}

describe('producer detection (descriptor provider stamp)', () => {
  it('recognizes a child spawned through the cicada-producer provider', () => {
    const agent = agentWithEvents([
      { type: 'user/message', data: {} },
      { type: 'subagent/descriptor', data: { provider: 'cicada-producer', mode: 'one-shot' } },
    ])
    expect(isProducer(agent)).toBe(true)
    expect(descriptorOf(agent)?.provider).toBe('cicada-producer')
  })

  it('does not recognize a plain spawn child or a bare agent', () => {
    expect(isProducer(agentWithEvents([{ type: 'subagent/descriptor', data: { provider: 'spawn' } }]))).toBe(false)
    expect(isProducer(agentWithEvents([]))).toBe(false)
  })

  it('uses the last descriptor when multiple exist', () => {
    const agent = agentWithEvents([
      { type: 'subagent/descriptor', data: { provider: 'spawn' } },
      { type: 'subagent/descriptor', data: { provider: 'cicada-producer' } },
    ])
    expect(isProducer(agent)).toBe(true)
  })
})

describe('scoped tool installation (G3: main has no write tools; producer does)', () => {
  it('registers scoped definitions and applies the deny list on the agent ctx', () => {
    const registered: string[] = []
    let restriction: { deny?: string[] } | undefined
    const tools = {
      register: (definition: { name: string }) => {
        registered.push(definition.name)
        return () => undefined
      },
      restrict: (filter: { deny?: string[] }) => {
        restriction = filter
      },
    }
    const agent = { ctx: { get: (name: string) => (name === 'tools' ? tools : undefined) } } as unknown as Agent
    installScopedTools(agent, [{ name: 'place_symbol' }, { name: 'connect_pins' }] as never, PRODUCER_DENY)

    expect(registered).toEqual(['place_symbol', 'connect_pins'])
    expect(restriction?.deny).toContain('datasheet_library_check')
    expect(restriction?.deny).toContain('spawn_producer')
    // `subagent` is deliberately absent from the table: tool-subagent registers
    // it in the child's own scope, and restrict() filters inherited names only,
    // so listing it would be a silent no-op (measured 2026-09-13).
    expect(PRODUCER_DENY).not.toContain('subagent')
  })

  it('validates the deny list against the AGENT view, so preset-layer names survive', () => {
    // Regression (2026-09-13): `tools.schemas()` without a scope only knows the
    // global layer, so every preset-layer name was dropped from the deny list
    // and a producer kept seeing spawn_knowledge / spawn_datasheet / subagent_fork.
    let restriction: { deny?: string[] } | undefined
    const scopesSeen: unknown[] = []
    const tools = {
      register: () => () => undefined,
      schemas: (scope?: unknown) => {
        scopesSeen.push(scope)
        // Global view knows only the global layer; the agent view also knows the
        // preset layer (spawn_producer / subagent_fork) — the difference the fix is about.
        const global = ['read', 'write', 'datasheet_library_check']
        const scoped = [...global, 'spawn_producer', 'subagent_fork']
        return (scope === undefined ? global : scoped).map(name => ({ name }))
      },
      restrict: (filter: { deny?: string[] }) => { restriction = filter },
    }
    const agent = { ctx: { get: (name: string) => (name === 'tools' ? tools : undefined) } } as unknown as Agent
    installScopedTools(agent, [], PRODUCER_DENY, { scopeOf: () => ({ scoped: true }) })

    expect(scopesSeen[0]).toEqual({ scoped: true })
    // Preset-layer names survive the filter now (before the fix they were dropped).
    expect(restriction?.deny).toContain('spawn_producer')
    expect(restriction?.deny).toContain('subagent_fork')
    // Global-layer names still survive.
    expect(restriction?.deny).toContain('datasheet_library_check')
    // A name no layer carries is withheld from restrict() (an unknown name throws).
    expect(restriction?.deny).not.toContain('ralph')
    // Names the list does not mention are never added.
    expect(restriction?.deny).not.toContain('read')
  })

  it('is a no-op when the tools service is absent', () => {
    const agent = { ctx: { get: () => undefined } } as unknown as Agent
    expect(() => installScopedTools(agent, [{ name: 'x' }] as never, ['y'])).not.toThrow()
  })
})

describe('knowledge read boundary (docs/05 §8-⑤)', () => {
  const agentWith = (provider: string) => ({ session: { events: [{ type: 'subagent/descriptor', data: { provider } }] } }) as never

  it('denies the knowledge child any read of a datasheet copy', () => {
    const knowledge = agentWith('cicada-knowledge')
    for (const [tool, args] of [
      ['read', { file_path: 'C:\\ws\\datasheet\\STM32F103C8T6\\full.md' }],
      ['read', { path: 'datasheet/AMS1117-3.3/full.md' }],
      ['grep', { pattern: 'datasheet/**', path: 'datasheet' }],
      ['read', { file_path: 'C:/dsh/home/datasheets/NE555P/full.md' }],
    ] as [string, Record<string, string>][]) {
      expect(knowledgeDatasheetReadDenial(knowledge, tool, args)).toContain('may not read a datasheet copy')
    }
  })

  it('leaves research, other files and the other roles alone', () => {
    const knowledge = agentWith('cicada-knowledge')
    expect(knowledgeDatasheetReadDenial(knowledge, 'read', { file_path: '.cicada/design_intent.json' })).toBeUndefined()
    expect(knowledgeDatasheetReadDenial(knowledge, 'web_fetch', { url: 'https://example.invalid/ds.pdf' })).toBeUndefined()
    expect(knowledgeDatasheetReadDenial(knowledge, 'read', { file_path: 'README.md' })).toBeUndefined()
    // datasheet 道必须能读它自己的文档；producer 经工具读组，不经 read。
    expect(knowledgeDatasheetReadDenial(agentWith('cicada-datasheet'), 'read', { file_path: 'datasheet/STM32F103C8T6/full.md' })).toBeUndefined()
    expect(knowledgeDatasheetReadDenial(agentWith('spawn'), 'read', { file_path: 'datasheet/STM32F103C8T6/full.md' })).toBeUndefined()
    expect(knowledgeDatasheetReadDenial(undefined, 'read', { file_path: 'datasheet/x/full.md' })).toBeUndefined()
  })

  it('recognizes the knowledge stamp', () => {
    expect(isKnowledge(agentWith('cicada-knowledge'))).toBe(true)
    expect(isKnowledge(agentWith('cicada-datasheet'))).toBe(false)
    expect(isKnowledge(agentWith('cicada-producer'))).toBe(false)
  })
})

describe('landscape single-author gate (docs/05 §8-⑦)', () => {
  const main = { session: { header: {} } }
  const child = { session: { header: { parentSession: 's1' } } }

  it('denies every write tool the root session points at the landscape', () => {
    // 实测（2026-09-13）：main 曾用 edit 直接改图景写入 FB-07；这里测的是生产函数本身
    // （runtime 的 tools/pre-execute 监听器直接调用它，不再有第二份判定逻辑）。
    for (const tool of ['write', 'edit', 'str_replace_editor']) {
      expect(landscapeWriteDenial(main, tool, { file_path: 'C:\\ws\\.cicada\\design_intent.json' })).toContain('single author')
      expect(landscapeWriteDenial(main, tool, { path: '.cicada/design_intent.json' })).toContain('single author')
    }
  })

  it('allows everything else: other files, other tools, and the knowledge child', () => {
    expect(landscapeWriteDenial(main, 'write', { file_path: '.cicada/schematic.cicada_sch' })).toBeUndefined()
    expect(landscapeWriteDenial(main, 'read', { file_path: '.cicada/design_intent.json' })).toBeUndefined()
    expect(landscapeWriteDenial(main, 'edit', {})).toBeUndefined()
    expect(landscapeWriteDenial(child, 'edit', { file_path: '.cicada/design_intent.json' })).toBeUndefined()
    expect(landscapeWriteDenial(undefined, 'edit', { file_path: '.cicada/design_intent.json' })).toBeUndefined()
  })
})
