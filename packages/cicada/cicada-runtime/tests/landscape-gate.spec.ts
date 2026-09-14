import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

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

/** Injected runtime verdicts (the gate writes user-role plugin messages). */
function gateMessages(agent: Agent): string[] {
  return [...agent.session.events]
    .filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-cicada-runtime')
    .map(event => event.data.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** Valid v0.3 knowledge landscape (trimmed STM32 minimum-system instance). */
const landscape = (): unknown => ({
  schema_version: '0.3',
  request_id: 'accept-001',
  selected_parts: {
    parts: [
      { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', datasheet_required: true },
      { part_ref: 'part_ams1117', part_number: 'AMS1117-3.3', datasheet_required: true },
    ],
  },
  datasheet_requests: [
    { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', reason: '引脚定义' },
    { part_ref: 'part_ams1117', part_number: 'AMS1117-3.3', reason: '引脚与电容要求' },
  ],
})

describe('knowledge-landscape gate (docs/05 §8)', () => {
  let ctx: Context | undefined
  let workspace: string | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
    workspace = undefined
  })

  const mount = async (adapter: MockAdapter): Promise<void> => {
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(CicadaFormat)
    await ctx.plugin(CicadaDeriver)
    await ctx.plugin(CicadaKnowledge, { dataRoot: join(workspace!, '.cicada-data') })
    await ctx.plugin(CicadaRuntime)
  }

  it('reports one verdict per landscape revision: pass, silence, then violations', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-landscape-'))
    await mount(new MockAdapter([
      textResponse('TURN_1'),
      textResponse('TURN_2'),
      textResponse('TURN_3'),
      textResponse('TURN_4'),
    ]))
    const agent = ctx!.agentLoop.create(SessionId('cicada-landscape-main'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const stateDir = join(workspace, '.cicada')
    await mkdir(stateDir, { recursive: true })

    // Turn 1 — the knowledge lane has not started: the gate stays silent.
    agent.followup(user('先聊聊需求'))
    await waitForIdle(ctx!, agent)
    expect(gateMessages(agent)).toHaveLength(0)

    // Turn 2 — a valid landscape: one notice naming the datasheet lane.
    await writeFile(join(stateDir, 'design_intent.json'), JSON.stringify(landscape()), 'utf8')
    agent.followup(user('继续'))
    await waitForIdle(ctx!, agent)
    const passed = gateMessages(agent)
    expect(passed).toHaveLength(1)
    expect(passed[0]).toContain('知识图景已通过校验')
    expect(passed[0]).toContain('STM32F103C8T6')
    expect(passed[0]).toContain('AMS1117-3.3')

    // Turn 3 — same revision: no repeat.
    agent.followup(user('再继续'))
    await waitForIdle(ctx!, agent)
    expect(gateMessages(agent)).toHaveLength(1)

    // Turn 4 — a broken revision: the violations themselves.
    await writeFile(join(stateDir, 'design_intent.json'), JSON.stringify({
      selected_parts: { parts: [{ part_ref: 'part_mcu', part_number: 'STM32F103C8T6' }] },
      datasheet_requests: [{ part_ref: 'part_opamp', part_number: 'LM358' }],
    }), 'utf8')
    agent.followup(user('再继续'))
    await waitForIdle(ctx!, agent)
    const failed = gateMessages(agent)
    expect(failed).toHaveLength(2)
    expect(failed[1]).toContain('知识图景校验未通过')
    expect(failed[1]).toContain('LM358')
  }, 30_000)

  it('never injects the verdict into a subagent', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cicada-landscape-child-'))
    await mount(new MockAdapter([
      toolCallResponse('spawn-1', 'subagent', { description: 'research', prompt: 'Look something up.' }),
      textResponse('CHILD_DONE'),
      textResponse('MAIN_DONE'),
    ]))
    await ctx!.plugin(SubagentRuntime)
    await ctx!.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx!.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })

    // A one-shot child is disposed when its run ends, so keep the reference
    // from creation and read its session afterwards.
    const children: Agent[] = []
    ctx!.on('agent/created', ({ agent: created }) => {
      if (created.session.header.parentSession !== undefined) children.push(created)
    })

    const agent = ctx!.agentLoop.create(SessionId('cicada-landscape-root'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const stateDir = join(workspace, '.cicada')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'design_intent.json'), JSON.stringify(landscape()), 'utf8')

    agent.followup(user('派一个子代理去查资料'))
    await waitForIdle(ctx!, agent)
    expect(gateMessages(agent)).toHaveLength(1)

    expect(children, 'the subagent ran').toHaveLength(1)
    expect(gateMessages(children[0]!)).toHaveLength(0)
  }, 30_000)
})
