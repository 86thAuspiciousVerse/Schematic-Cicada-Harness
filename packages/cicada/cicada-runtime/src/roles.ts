/**
 * Producer detection and scoped tool injection (9-impl §2.2, P3 定案).
 *
 * Detection reads the child's durable `subagent/descriptor` session event
 * (appended inside the creation window) and matches the provider name
 * `cicada-producer` — the second `subagent-spawn-in-process` instance the
 * bundle mounts with `providerName: cicada-producer`. The producer's scoped
 * registrations then live on `agent.ctx` and apply to that agent alone;
 * `tools.restrict` and scoped registrations make the surface exact
 * (restrictions never apply to scoped registrations, so the producer keeps
 * its write tools while every global-denied name stays hidden).
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Provider name stamped on knowledge children (bundle row `providerName`). */
export const KNOWLEDGE_PROVIDER = 'cicada-knowledge'

/** Provider name stamped on datasheet children (bundle row `providerName`). */
export const DATASHEET_PROVIDER = 'cicada-datasheet'

/** Provider name stamped on producer children (bundle row `providerName`). */
export const PRODUCER_PROVIDER = 'cicada-producer'

/**
 * Global tool names the producer must not see (main-only lane + spawn family).
 * `subagent` is deliberately absent: tool-subagent registers it in each Agent's
 * own scope, and `restrict()` filters inherited names only, so listing it here
 * would be a silent no-op (the child's nesting is refused by `maxDepth: 1`).
 */
export const PRODUCER_DENY = [
  'datasheet_library_check',
  'datasheet_library_copy',
  'mineru_extract',
  'subagent_fork',
  'spawn_producer',
  'workflow',
  'ralph',
]

/** Find the last `subagent/descriptor` event in the agent's session log. */
export function descriptorOf(agent: Agent): { provider: string | undefined } | undefined {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The descriptor event is declared by dsh-subagent; read it structurally
    // here to keep cicada-runtime independent of that package's types.
    const event = events[index] as { type?: string; data?: { provider?: unknown } } | undefined
    if (event?.type !== 'subagent/descriptor') continue
    const provider = event.data?.provider
    return { provider: typeof provider === 'string' ? provider : undefined }
  }
  return undefined
}

/** Whether the agent is the producer child (provider-stamped). */
export function isProducer(agent: Agent): boolean {
  return descriptorOf(agent)?.provider === PRODUCER_PROVIDER
}

void PRODUCER_PROVIDER

/**
 * Register scoped tools and restrictions on an agent (unwound automatically
 * when the agent's context is disposed).
 * @param agent - the target agent.
 * @param definitions - tool definitions to register (scoped).
 * @param deny - global names to restrict away for this agent.
 */
export function installScopedTools(
  agent: Agent,
  definitions: readonly ToolDefinition[],
  deny: readonly string[],
  deps: { scopeOf?: (ctx: unknown) => unknown } = {},
): void {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) return
  for (const definition of definitions) tools.register(definition)
  if (deny.length > 0) {
    // `restrict()` validates names against the scope's INHERITED surface and
    // throws on an unknown name, so the list must be filtered to names that
    // exist. Read that surface through the AGENT's scope: the unscoped view
    // only knows the global layer, which silently dropped every preset-layer
    // name from the deny list — that is why a producer kept seeing
    // spawn_knowledge / spawn_datasheet / subagent_fork (measured 2026-09-13).
    const scope = (deps.scopeOf ?? scopeOf)(agent.ctx)
    const schemas = typeof tools.schemas === 'function' ? tools.schemas(scope as never) : undefined
    const known = schemas === undefined ? undefined : new Set(schemas.map((schema: { name: string }) => schema.name))
    const effectiveDeny = known === undefined ? deny : deny.filter(name => known.has(name))
    if (effectiveDeny.length > 0) tools.restrict({ deny: [...effectiveDeny] })
  }
}

/**
 * ⑦ 图景单一作者闸门（实测 2026-09-13：main 曾用 `edit` 直接改
 * `.cicada/design_intent.json`，散文化约束拦不住）。根会话对图景文件的写工具一律拒绝；
 * 子代理（knowledge）与其它文件不受影响。
 * @param agent - the calling agent, when the call runs on an agent's behalf.
 * @param toolName - the tool being dispatched.
 * @param args - the pending call's arguments (a write tool names its target).
 * @returns the denial reason, or undefined to allow the call.
 */
export function landscapeWriteDenial(
  agent: { session: { header: { parentSession?: string } } } | undefined,
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'str_replace_editor') return undefined
  if (agent?.session.header.parentSession !== undefined) return undefined
  if (agent === undefined) return undefined
  const record = args as { file_path?: unknown; path?: unknown } | undefined
  const target = String(record?.file_path ?? record?.path ?? '')
  if (!target.replaceAll('\\', '/').endsWith('.cicada/design_intent.json')) return undefined
  return 'the knowledge landscape (.cicada/design_intent.json) has a single author: the knowledge subagent. Send it a message to refine the landscape instead of editing the file yourself.'
}

/** Whether this agent is a knowledge child (descriptor provider stamp). */
export function isKnowledge(agent: Agent): boolean {
  return descriptorOf(agent)?.provider === KNOWLEDGE_PROVIDER
}

/**
 * 知识道的读边界（2026-09-13）：它的事实必须来自检索与推理，不能来自工作区里的数据手册
 * 拷贝——那是 datasheet 道的权威资料（实测：知识道确实自己读过 `datasheet/<part>/full.md`
 * 并把参数标成 `source_kind: datasheet`）。
 * @param agent - the calling agent, when the call runs on an agent's behalf.
 * @param toolName - the tool being dispatched.
 * @param args - the pending call's arguments (a read tool names its target).
 * @returns the denial reason, or undefined to allow the call.
 */
export function knowledgeDatasheetReadDenial(
  agent: Agent | undefined,
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName !== 'read' && toolName !== 'grep' && toolName !== 'glob' && toolName !== 'read_image') return undefined
  if (agent === undefined || !isKnowledge(agent)) return undefined
  const record = args as { file_path?: unknown; path?: unknown; pattern?: unknown } | undefined
  // 三个字段都看：read 用 file_path、grep 可能只给 path/pattern。
  const target = [record?.file_path, record?.path, record?.pattern]
    .map((value) => String(value ?? ''))
    .join(' ')
    .replaceAll('\\', '/')
  if (!/(^|[\s/])datasheets?([\s/]|$)/i.test(target)) return undefined
  return 'the knowledge stage may not read a datasheet copy (workspace `datasheet/` or the shared `datasheets/` library): research the part and reason; the datasheet lane owns those documents.'
}
