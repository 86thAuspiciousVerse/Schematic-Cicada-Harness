import z from '@deepseek-ai/schemastery'
/**
 * `cicada-mineru` host plugin: the MinerU service plus the main-side
 * `mineru_extract(url, name)` tool. Network and settings are injected;
 * the tool writes the extracted markdown into the workspace
 * `datasheet/<name>/full.md` plus a meta file (exact part-number naming).
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { FetchLike, MineruClient } from './client.ts'

/** Workspace write surface the tool needs (satisfied by `ctx.fs`). */
export interface WorkspaceFs {
  resolve(path: string, opts?: { cwd?: string }): Promise<{ targetKey: unknown; displayPath: string }>
  writeText(target: { displayPath: string; targetKey: unknown }, content: string, expected?: unknown): Promise<{ operation: 'create' | 'update'; version: unknown }>
  readText(target: { displayPath: string; targetKey: unknown }): Promise<string>
  stat(target: { displayPath: string; targetKey: unknown }): Promise<{ version: unknown } | undefined>
}

/** Exact-part-number validation (path safety + generic-name rejection). */
export function isValidPartName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,}$/.test(name) && name.length > 2
}

/** The MinerU service registered as `cicadaMineru`. */
export class CicadaMineru {
  readonly client: MineruClient

  constructor(
    public readonly ctx: Context,
    fetchImpl: FetchLike,
    token: string | undefined,
    baseUrl?: string,
  ) {
    this.client = new MineruClient(fetchImpl, token, baseUrl)
  }

  /** Register the main-side mineru_extract tool. */
  tool(host: {
    resolveCwd(agent: { session: { header: { cwd?: string } } } | undefined): string | undefined
  }): ToolDefinition {
    const client = this.client
    const service = this
    return defineTool({
      name: 'mineru_extract',
      description: 'Convert a datasheet URL to markdown via MinerU and write it into the workspace '
        + '`datasheet/<name>/full.md`. `name` MUST be the exact part number (e.g. STM32C011J4M6), never a generic label.',
      parameters: {
        url: { type: 'string', required: true, description: 'Datasheet URL (PDF/document).' },
        name: { type: 'string', required: true, description: 'Exact part number = output folder name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'integer' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { url: string; name: string }, exec) {
        if (!isValidPartName(args.name)) {
          throw new Error(`mineru_extract: "${args.name}" is not an exact part number`)
        }
        const cwd = host.resolveCwd(exec.agent)
        if (cwd === undefined) throw new Error('mineru_extract: no workspace (session cwd) for the output')
        const { fullMd, meta } = await client.run(args.url)
        await writeInto(service, cwd, args.name, fullMd, meta)
        return { ok: true, message: `已生成 datasheet/${args.name}/full.md。`, name: args.name, bytes: Buffer.byteLength(fullMd, 'utf8') }
      },
    })
  }
}

async function writeInto(service: CicadaMineru, cwd: string, name: string, fullMd: string, meta: unknown): Promise<void> {
  const fs = service.ctx.get('fs') as unknown as WorkspaceFs | undefined
  if (fs === undefined) throw new Error('mineru_extract: fs service unavailable')
  const fullText = await fs.resolve(`datasheet/${name}/full.md`, { cwd })
  const metaText = await fs.resolve(`datasheet/${name}/meta.json`, { cwd })
  // Re-extraction of an existing part must replace its copy (a failed first
  // attempt leaves a folder behind), so write guarded by the current version.
  const writeOnce = async (target: typeof fullText, content: string): Promise<void> => {
    const current = await fs.stat(target)
    await fs.writeText(target, content, current === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current.version })
  }
  await writeOnce(fullText, fullMd)
  await writeOnce(metaText, JSON.stringify(meta, null, 1))
}

export const name = 'cicada-mineru'
export const inject = ['fs', 'settings']

/** Namespace the plugin owns in the settings document (`settings.yaml`). */
export const MINERU_SETTINGS_NAMESPACE = 'mineru'

/** The section this plugin registers: the token, and an optional API base. */
export const MineruSettingsSchema = z.object({
  token: z.string().default(''),
  baseUrl: z.string().default(''),
})

/** The settings service surface this plugin uses (register, then read). */
interface SettingsRegistry {
  register: (ns: string, schema: unknown) => { get: () => unknown }
}

/**
 * Resolve the MinerU token, in precedence order:
 * settings document → plugin/row config → environment.
 *
 * The settings value MUST come from a namespace this plugin registered:
 * `Settings.get(ns)` answers `undefined` for unregistered namespaces, so the old
 * read-only lookup silently ignored `mineru.token` in `settings.yaml` — the
 * product had no working channel unless MINERU_TOKEN happened to be exported
 * (probes did, the product did not).
 * @param config - plugin config (entry-config layer).
 * @param scope - registered settings scope, when a settings provider exists.
 * @param env - environment lookup (defaults to `process.env`).
 * @returns the token, or undefined when no source provides one.
 */
export function resolveMineruToken(
  config: { token?: string } = {},
  scope?: { get: () => unknown },
  env: NodeJS.ProcessEnv | undefined = typeof process === 'undefined' ? undefined : process.env,
): string | undefined {
  const section = scope?.get() as { token?: unknown } | undefined
  const candidates = [section?.token, config.token, env?.MINERU_TOKEN]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** Plugin config: MinerU token and optional API base override. */
export interface Config {
  token?: string
  baseUrl?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  // Register (not merely read) the namespace: this is what makes
  // `mineru.token` in settings.yaml visible — and what gives the settings UI a
  // MinerU section to edit.
  let scope: { get: () => unknown } | undefined
  const settings = ctx.get('settings') as SettingsRegistry | undefined
  if (settings !== undefined) {
    try {
      scope = settings.register(MINERU_SETTINGS_NAMESPACE, MineruSettingsSchema)
    } catch (error) {
      // A duplicate registration is a composition error worth surfacing, but it
      // must not silently disable the channel: fall through to config/env.
      ctx.logger?.warn?.(`cicada-mineru: settings namespace not registered: ${String(error)}`)
    }
  }
  const token = resolveMineruToken(config, scope)
  const fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>
  const service = new CicadaMineru(ctx, fetchImpl, token, config.baseUrl)
  ctx.effect(() => ctx.provide('cicadaMineru', service))
  const tools = ctx.get('tools')
  const cwdOf = (agent: { session: { header: { cwd?: string } } } | undefined): string | undefined => agent?.session.header.cwd
  if (tools !== undefined) tools.register(service.tool({ resolveCwd: cwdOf }))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaMineru: CicadaMineru
  }
}
