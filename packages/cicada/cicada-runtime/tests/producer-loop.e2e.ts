import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

/** Poll until the workspace file carries `needle` (a background producer commits at turn end). */
async function waitForFile(path: string, needle: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const text = await readFile(path, 'utf8')
      if (text.includes(needle)) return text
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle} in ${path}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

import * as CicadaFormat from '@deepseek-ai/dsh-cicada-format'
import * as CicadaDeriver from '@deepseek-ai/dsh-cicada-deriver'
import * as CicadaKnowledge from '@deepseek-ai/dsh-cicada-knowledge'
import * as CicadaRuntime from '../src/index.ts'

const endpoint = process.env.CICADA_E2E_ENDPOINT ?? process.env.DEEPSEEK_BASE_URL
const apiKey = process.env.CICADA_E2E_API_KEY ?? process.env.DEEPSEEK_API_KEY
const model = process.env.CICADA_E2E_MODEL ?? 'deepseek-v4-flash'

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

function runtimeEditMessages(agent: Agent): string[] {
  return [...agent.session.events]
    .filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-cicada-runtime')
    .map(event => event.data.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

async function userEditCount(workspace: string): Promise<number> {
  const text = await readFile(join(workspace, '.cicada', 'changelog.jsonl'), 'utf8')
  return text.split('\n').filter(Boolean).filter(line => JSON.parse(line).type === 'user_edit').length
}

describe.skipIf(endpoint === undefined || apiKey === undefined)('real P7/G7 producer loop', () => {
  let ctx: Context | undefined
  let workspace: string | undefined
  let credentials: string | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
    if (credentials !== undefined) await rm(credentials, { recursive: true, force: true })
    workspace = undefined
    credentials = undefined
  })

  it('runs the real model through producer, then consumes one external edit on the next turn', async () => {
    if (endpoint === undefined || apiKey === undefined) throw new Error('real P7/G7 test requires endpoint and API key')
    workspace = await mkdtemp(join(tmpdir(), 'cicada-real-p7-'))
    credentials = await mkdtemp(join(tmpdir(), 'cicada-real-creds-'))
    const credentialFile = join(credentials, '.credentials.yaml')
    await writeFile(credentialFile, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${JSON.stringify(apiKey)}\n`, { mode: 0o600 })

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: credentialFile, watch: false })
    await ctx.plugin(LlmDeepSeek, { baseURL: endpoint, apiKeyEnv: 'DEEPSEEK_API_KEY', reasoningEffort: 'max' })
    await ctx.plugin(AgentLoop, { agents: [] })
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

    const agent = ctx.agentLoop.create(SessionId('cicada-real-p7-loop'), {
      provider: 'deepseek-official', model,
    }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Use spawn_producer exactly once now. Build a minimal circuit with R1 value 10k and C1 value 100nF, connected from R1.2 to C1.1. Do not merely explain; perform the tool call and report completion.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // The producer runs as a background continuable child (docs/05 §8), so the
    // orchestrator's own turn ends before the child's first turn commits.
    const schematicPath = join(workspace, '.cicada', 'schematic.cicada_sch')
    const initial = await waitForFile(schematicPath, '10k')
    expect(initial).toContain('10k')
    const changed = initial.replace('10k', '4.7k')
    await writeFile(schematicPath, changed, 'utf8')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue the conversation and briefly summarize the current drawing.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    expect(runtimeEditMessages(agent)).toHaveLength(1)
    expect(runtimeEditMessages(agent)[0]).toContain('R1 值 10k → 4.7k')
    expect(await userEditCount(workspace)).toBe(1)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Summarize the current drawing in one sentence.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    expect(runtimeEditMessages(agent)).toHaveLength(1)
    expect(await userEditCount(workspace)).toBe(1)
  }, 180_000)
})
