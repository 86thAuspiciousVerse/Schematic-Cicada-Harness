/**
 * `cicada-knowledge` host plugin: the global datasheet database (single
 * writer = anchor-audited upsert), the workspace pin-universe reader, and the
 * main-side + producer-side datasheet tools.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-cicada-launcher'

import { GlobalDatasheetDb, type DatasheetEntry } from './database.ts'
import { runAudit } from './audit.ts'
import { workspaceDatasheetPins, readWorkspaceShapeBlock, readWorkspaceRootShapeBlock } from './workspace.ts'
import type { ShapeBlock } from './schema.ts'
import { mainDatasheetTools, producerDatasheetTools } from './tools.ts'
import { checkLandscape, type LandscapeCheck } from './landscape.ts'
import type { DatasheetPinSource } from '@deepseek-ai/dsh-cicada-runtime'
export { validateDesignIntent } from './intent.ts'
export { checkLandscape, LANDSCAPE_FILE_NAME } from './landscape.ts'
export type { LandscapeCheck, LandscapeState } from './landscape.ts'
export type { DatasheetRequest, DesignIntent, DesignIntentPart } from './intent.ts'
export type { DatasheetGroup, DatasheetPin, ShapeBlock, SourceClaim } from './schema.ts'

/** The registered service (`ctx.cicadaKnowledge`). */
export class CicadaKnowledge {
  readonly db: GlobalDatasheetDb

  constructor(
    public readonly ctx: Context,
    dataRoot?: string,
  ) {
    // GlobalDatasheetDb owns the `datasheets/` child directory; pass its
    // parent root so the default resolves to <dshHome>/datasheets/<part>.
    this.db = new GlobalDatasheetDb(dataRoot ?? resolveDshHome())
  }

  /** Pin-universe source for the runtime op host (workspace copy). */
  workspaceDatasheetPins(workspace: string, part: string): DatasheetPinSource | undefined {
    return workspaceDatasheetPins(workspace, part)
  }

  /** M1e-1 自动查缺源：workspace `datasheet/<part>/shape.json`（形状块独立文件）。 */
  workspaceShapeBlock(workspace: string, part: string): ShapeBlock | undefined {
    return readWorkspaceShapeBlock(workspace, part)
  }

  /** M1e-1 自动查缺源（回退）：workspace 根目录 shape.json（块内 name 与 part 一致才返回）。 */
  workspaceRootShapeBlock(workspace: string, part: string): ShapeBlock | undefined {
    return readWorkspaceRootShapeBlock(workspace, part)
  }

  /** Anchor-audit then upsert (the ONLY write path into the global DB). */
  upsert(part: string, entry: DatasheetEntry): { ok: boolean; violations: { field: string; message: string }[] } {
    const audit = runAudit(entry, part)
    if (!audit.ok) return audit
    this.db.put(part, entry)
    return audit
  }

  /**
   * Knowledge-landscape gate (docs/05 §8): validate `<stateDir>/design_intent.json`.
   * @param stateDir - the workspace state directory (`<cwd>/.cicada`).
   * @returns the hash-keyed verdict the runtime reports to the main agent.
   */
  checkLandscape(stateDir: string): LandscapeCheck {
    return checkLandscape(stateDir)
  }

  /** Producer-scoped read tools (workspace copy only). */
  producerReadToolDefinitions(host: { workspaceRoot(agent?: { session: { header: { cwd?: string } } }): string | undefined }): ToolDefinition[] {
    return producerDatasheetTools(host)
  }
}

export const name = 'cicada-knowledge'
export const inject = ['fs']

/** Plugin config: optional parent root override (DB stores under its `datasheets/` child). */
export interface Config {
  dataRoot?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const service = new CicadaKnowledge(ctx, config.dataRoot)
  ctx.effect(() => ctx.provide('cicadaKnowledge', service))
  // Main-side tools resolve the workspace from the CALLING agent's session.
  const host = {
    workspaceRoot: (agent?: { session: { header: { cwd?: string } } }) => agent?.session.header.cwd,
    fs: () => ctx.get('fs'),
  }
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    for (const definition of mainDatasheetTools(service, host)) tools.register(definition)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicadaKnowledge: CicadaKnowledge
  }
}
