/**
 * The datasheet tool surface, split by LANE (docs/05 §8) — the two lanes never
 * mean the same thing, so the names say which one they touch:
 *
 * main agent (SHARED library, keyed by the exact IC part number):
 *   `datasheet_library_check`    1↔3 status of the library entry (index/detail/shape)
 *   `datasheet_library_copy`     copy that entry into `datasheet/<part_number>/`
 *   `datasheet_library_publish`  audit the WORKSPACE artifacts and store them in the library
 *   `record_group_decision`      append one decision to the workspace ledger
 *
 * producer (THIS workspace copy, read-only):
 *   `datasheet_workspace_list`        which datasheets/groups this workspace has
 *   `datasheet_workspace_read_group`  one group's pin detail
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isValidPartName } from '@deepseek-ai/dsh-cicada-mineru'

import type { CicadaKnowledge } from './index.ts'
import { checkLandscape } from './landscape.ts'
import type { DatasheetStatus } from './database.ts'
import type { ExternalComponent, OperatingLimit, PinFunction, SourceClaim } from './schema.ts'
import { similarParts } from './similar.ts'
import {
  listWorkspaceGroups, readWorkspaceDetail, readWorkspaceEntry, readWorkspaceIndexFile,
} from './workspace.ts'

/** Tool host: workspace root + fs write surface (ctx.fs) for copies/ledger. */
export interface KnowledgeToolHost {
  workspaceRoot(agent?: { session: { header: { cwd?: string } } }): string | undefined
  fs(): {
    resolve(path: string, opts?: { cwd?: string }): Promise<{ targetKey: unknown; displayPath: string }>
    writeText(target: { targetKey: unknown }, content: string, expected?: unknown): Promise<unknown>
    readText(target: { targetKey: unknown }): Promise<string>
    stat(target: { targetKey: unknown }): Promise<{ version: unknown } | undefined>
  } | undefined
}

const ok = <T>(value: T, message: string): { ok: true; message: string } & T => ({ ok: true as const, message, ...value })

/** Render the 1↔3 verdict of one library entry, naming the missing artifacts. */
function libraryVerdict(status: DatasheetStatus): string {
  if (!status.found) {
    return `共享库没有 ${status.part_number}（index/detail/shape 全缺）：派一个 datasheet 子代理产出这三件套。`
  }
  const artifacts = [
    'index',
    `detail${status.missingDetailGroups.length > 0 ? `（缺组 ${status.missingDetailGroups.join('、')}）` : ''}`,
    'shape',
  ]
  const have = [status.haveIndex, status.haveDetail, status.haveShape]
  const state = artifacts.map((name, index) => `${name}=${have[index] ? '有' : '无'}`).join('，')
  const next = !status.haveDetail
    ? 'detail 不全：仍需 datasheet 子代理补齐。'
    : !status.haveShape
      ? 'detail 可复用，但没有 shape 块：放置该 IC 前仍需产出形状块。'
      : '三件套齐全：datasheet_library_copy 拉进工作区即可复用。'
  return `共享库命中 ${status.part_number}：${state}（${status.groups} 组）。${next}`
}

/** Read one JSON file, or undefined when it is absent or unparsable. */
function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined
  } catch {
    return undefined
  }
}

/** Claims as the open-JSON tool payload wants them (v3). */
const claimViews = (claims: readonly SourceClaim[] | undefined) => (claims ?? []).map((claim) => ({
  claim_id: claim.claim_id,
  source_kind: claim.source_kind,
  source_ref: claim.source_ref,
  section: claim.section ?? '',
  extracted_fact: claim.extracted_fact,
  verbatim_excerpt: claim.verbatim_excerpt ?? '',
  confidence: claim.confidence ?? '',
}))

/** External components as the open-JSON tool payload wants them (v3). */
const externalComponentViews = (items: readonly ExternalComponent[] | undefined) => (items ?? []).map((item) => ({
  ref_kind: item.ref_kind,
  value: item.value,
  connection: item.connection,
  ...item.count === undefined ? {} : { count: item.count },
  ...item.why === undefined ? {} : { why: item.why },
  source_claim_ids: [...item.source_claim_ids ?? []],
}))

/** Operating limits as the open-JSON tool payload wants them (v3). */
const operatingLimitViews = (items: readonly OperatingLimit[] | undefined) => (items ?? []).map((item) => ({
  name: item.name,
  value: item.value ?? '',
  condition: item.condition ?? '',
  source_claim_ids: [...item.source_claim_ids ?? []],
}))

/** Pin functions as the open-JSON tool payload wants them (v3). */
const pinFunctionViews = (items: readonly PinFunction[] | undefined) => (items ?? []).map((item) => ({
  name: item.name,
  role: item.role ?? '',
  conditions: item.conditions ?? '',
}))

/** Main-side tools registered globally. */
export function mainDatasheetTools(service: CicadaKnowledge, host: KnowledgeToolHost): ToolDefinition[] {
  const db = service.db
  return [
    defineTool({
      name: 'datasheet_library_check',
      description: 'Check the SHARED datasheet library for one exact IC part number (the name that also names its folder, '
        + 'e.g. STM32F103C8T6 — never a generic label like "stm32"). Entry existence is 1 key ↔ 3 artifacts: index '
        + '(group list), detail (per-group pin data), shape (symbol shape block). Reports each separately, so a hit can '
        + 'still be missing detail or shape. found=false means the library has nothing for this part yet; the answer then '
        + 'also lists near-miss part numbers that DO exist, each with why it matched — those are DIFFERENT parts, never '
        + 'substitutes. Read-only: it never touches the workspace. Use datasheet_library_copy to bring a hit into the '
        + 'workspace.',
      parameters: {
        part_number: { type: 'string', required: true, description: 'Exact part number / IC name, e.g. STM32F103C8T6.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            found: { type: 'boolean' },
            part_number: { type: 'string' },
            have_index: { type: 'boolean' },
            have_detail: { type: 'boolean' },
            have_shape: { type: 'boolean' },
            groups: { type: 'integer' },
            missing_detail_groups: { type: 'array', items: { type: 'string' } },
            audited: { type: 'boolean' },
            hint: { type: 'string' },
            modified_at: { type: 'integer' },
            similar: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  part_number: { type: 'string' },
                  reason: { type: 'string' },
                  have_index: { type: 'boolean' },
                  have_detail: { type: 'boolean' },
                  have_shape: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { part_number: string }, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        if (!isValidPartName(args.part_number)) {
          return { ok: false, message: `不是合法部件名：${args.part_number}（必须是精确型号）。`, found: false, part_number: args.part_number, have_index: false, have_detail: false, have_shape: false, groups: 0, missing_detail_groups: [], similar: [] }
        }
        const status = db.statusOf(args.part_number)
        // 近失候选（2026-09-13，缺陷 4 的姊妹问题）：库以精确型号为键，实测里
        // AMS1117-3.3 与库中 AMS1117 只差后缀 → found=false 且不给任何线索，调用方
        // 只能重派一份本可复用的资料。**相近 ≠ 同一件**：只列候选与理由，不改判定。
        const similar = status.found
          ? []
          : similarParts(args.part_number, db.parts()).map((candidate) => {
            const candidateStatus = db.statusOf(candidate.part_number)
            return {
              part_number: candidate.part_number,
              reason: candidate.reason,
              have_index: candidateStatus.haveIndex,
              have_detail: candidateStatus.haveDetail,
              have_shape: candidateStatus.haveShape,
            }
          })
        // Ordering reminder AT the decision point (M1g 实测：主代理在知识图景落地前
        // 就拿澄清时听到的型号去查库): the work list is the landscape's
        // `datasheet_requests`, not the parts mentioned in the conversation.
        const workspace = host.workspaceRoot(exec.agent)
        const landscapeAbsent = workspace !== undefined
          && checkLandscape(join(workspace, '.cicada')).state === 'absent'
        return {
          ...landscapeAbsent
            ? { hint: '知识图景还没生成：datasheet 需求清单以 .cicada/design_intent.json 的 datasheet_requests 为准，先用 spawn_knowledge 产出它再查库/派单；当前这次查询不计入清单。' }
            : similar.length > 0
              ? { hint: `库里没有 ${args.part_number}，但有相近型号：${similar.map((item) => item.part_number).join('、')}。它们是**不同的件**，不要直接拿来替代：若确认是同一件的另一种写法，用 datasheet_library_copy(那个名字)把产物拉进工作区；否则按 datasheet_requests 派 datasheet 子代理产出 ${args.part_number}。` }
              : {},
          ok: true,
          message: libraryVerdict(status),
          found: status.found,
          part_number: status.part_number,
          have_index: status.haveIndex,
          have_detail: status.haveDetail,
          have_shape: status.haveShape,
          groups: status.groups,
          missing_detail_groups: status.missingDetailGroups,
          ...status.audited === undefined ? {} : { audited: status.audited },
          ...status.modified_at === undefined ? {} : { modified_at: status.modified_at },
          similar,
        }
      },
    }),
    defineTool({
      name: 'datasheet_library_copy',
      description: 'Copy the SHARED library entry of one exact IC part number into THIS workspace at '
        + '`datasheet/<part_number>/` — index.json, detail/<group_id>.json, shape.json when the library has one, and '
        + 'full.md. Only files this workspace does not have yet are written; existing files are never overwritten. Call '
        + 'datasheet_library_check first: this tool only reads the library, it never produces missing artifacts (a hit '
        + 'without a shape block still needs one before the part can be placed).',
      parameters: {
        part_number: { type: 'string', required: true, description: 'Exact part number / IC name present in the shared library.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            part_number: { type: 'string' },
            target_dir: { type: 'string' },
            copied: { type: 'array', items: { type: 'string' } },
            skipped: { type: 'array', items: { type: 'string' } },
            have_shape: { type: 'boolean' },
            stale: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { part_number: string }, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        const targetDir = `datasheet/${args.part_number}`
        const entry = db.get(args.part_number)
        if (entry === undefined) {
          return {
            ok: false,
            message: `共享库没有 ${args.part_number}：先派 datasheet 子代理产出 index/detail/shape，再回工作区用。`,
            part_number: args.part_number,
            target_dir: targetDir,
            copied: [],
            skipped: [],
            have_shape: false,
            stale: false,
          }
        }
        const fs = host.fs()
        const workspace = host.workspaceRoot(exec.agent)
        if (fs === undefined || workspace === undefined) throw new Error('datasheet_library_copy: no workspace or fs service')
        const copied: string[] = []
        const skipped: string[] = []
        const write = async (relative: string, content: string): Promise<void> => {
          const target = await fs.resolve(`${workspace}/${targetDir}/${relative}`, { cwd: workspace })
          // `createIfAbsent` rejects an existing target, so probe first: a second
          // copy of the same part must stay a no-op, not an error.
          if ((await fs.stat(target)) !== undefined) {
            skipped.push(relative)
            return
          }
          await fs.writeText(target, content, { kind: 'createIfAbsent' })
          copied.push(relative)
        }
        await write('full.md', entry.fullMd)
        await write('index.json', JSON.stringify(entry.index, null, 1))
        for (const [groupId, detail] of Object.entries(entry.detail)) {
          await write(`detail/${groupId}.json`, JSON.stringify(detail, null, 1))
        }
        const haveShape = entry.shape !== undefined
        if (haveShape) await write('shape.json', JSON.stringify(entry.shape, null, 1))
        const parts = [`新增 ${copied.length} 个文件`]
        if (skipped.length > 0) parts.push(`跳过已存在 ${skipped.length} 个`)
        // 契约版本落差（2026-09-13 适配）：copy **只补缺失、绝不覆盖**，所以工作区里的旧
        // v2 三件套会把库里的 v3 挡住——不报出来，调用方会拿着缺 description/设计指导层的
        // 旧产物继续画图，还以为自己用的是新契约。
        const libraryVersion = Number.parseFloat(String(entry.index.schema_version ?? ''))
        const workspaceRead = readWorkspaceIndexFile(workspace, args.part_number)
        const workspaceVersion = workspaceRead.state === 'ok'
          ? Number.parseFloat(String(workspaceRead.index.schema_version ?? ''))
          : Number.NaN
        const stale = Number.isFinite(libraryVersion) && Number.isFinite(workspaceVersion)
          && workspaceVersion < libraryVersion
        if (stale) {
          parts.push(`⚠️ 工作区这份是 v${String(workspaceVersion)}、共享库已是 v${String(libraryVersion)}：copy 不覆盖已存在文件，请按新契约**重产**该件（旧产物缺 description/设计指导层，审计也会拒）`)
        }
        const tail = haveShape ? '' : ' ⚠️ 共享库没有 shape 块：放置该 IC 前仍需产出形状块。'
        return ok(
          { part_number: args.part_number, target_dir: targetDir, copied, skipped, have_shape: haveShape, stale },
          `已从共享库复制 ${args.part_number} → ${targetDir}/（${parts.join('，')}）。${tail}`,
        )
      },
    }),
    defineTool({
      name: 'datasheet_library_publish',
      description: 'Publish THIS workspace `datasheet/<part_number>/` into the SHARED library, which every other '
        + 'workspace and session reads — so this is the orchestrator-only gate, and the files it writes are NOT part '
        + 'of this workspace. Reads index.json + detail/<group_id>.json + shape.json + full.md, runs the deterministic '
        + 'anchor audit (pin ownership, contiguous pin numbering, provenance claims on every pin-carrying group, shape '
        + 'covering exactly the pin universe, canonical pin sides) and stores the entry only when the audit passes. On '
        + 'failure it returns the exact violations — fix those files (or send the datasheet subagent back with them) '
        + 'and call it again. Never call it for another workspace, and never from a subagent.',
      parameters: {
        part_number: { type: 'string', required: true, description: 'Exact part number; also the workspace folder name under datasheet/.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            part_number: { type: 'string' },
            groups: { type: 'integer' },
            violations: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { part_number: string }, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        const workspace = host.workspaceRoot(exec.agent)
        if (workspace === undefined) throw new Error('datasheet_library_publish: no workspace')
        const base = { part_number: args.part_number, groups: 0 }
        if (!isValidPartName(args.part_number)) {
          return { ok: false, message: `不是合法部件名：${args.part_number}（必须是精确型号）。`, ...base }
        }
        const read = readWorkspaceEntry(workspace, args.part_number)
        if (read.state === 'absent') {
          return { ok: false, message: `工作区没有 datasheet/${args.part_number}/index.json：先产出三件套再发布。`, ...base }
        }
        if (read.state === 'invalid') {
          // Say WHICH failure it is: a present-but-unusable index used to be
          // reported as "file not found", which sent the model hunting for the
          // workspace instead of fixing the artifact.
          return { ok: false, message: `datasheet/${args.part_number}/index.json 存在但无法使用：${read.reason}（契约见 spawn_datasheet 的角色说明：v2 groups[]，或旧 v0.3 indexes[]）。`, ...base }
        }
        const entry = read.entry
        const groups = entry.index.groups.length
        const result = service.upsert(args.part_number, entry)
        if (!result.ok) {
          return {
            ok: false,
            message: `锚点审计未通过（${result.violations.length} 条）：修好这些字段再发布。`,
            part_number: args.part_number,
            groups,
            violations: result.violations.map((violation) => ({ field: violation.field, message: violation.message })),
          }
        }
        return {
          ok: true,
          message: `已发布 ${args.part_number} 到共享库（${groups} 组）。后续设计 datasheet_library_check 即可命中。`,
          part_number: args.part_number,
          groups,
          violations: [],
        }
      },
    }),
    defineTool({
      name: 'record_group_decision',
      description: 'Append one datasheet group decision to THIS workspace ledger (.cicada/ledger.json), keyed by part '
        + 'number + group id. Use it whenever a group changes what the design does, so the decision survives the '
        + 'conversation.',
      parameters: {
        part_number: { type: 'string', required: true, description: 'Exact part number.' },
        group_id: { type: 'string', required: true, description: 'Group id as written in the workspace `datasheet/<part_number>/index.json` (e.g. pinout, PIN-001).' },
        decision: { type: 'string', required: true, description: 'Decision text.' },
        rationale: { type: 'string', description: 'Optional rationale.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { part_number: string; group_id: string; decision: string; rationale?: string }, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        const fs = host.fs()
        const workspace = host.workspaceRoot(exec.agent)
        if (fs === undefined || workspace === undefined) throw new Error('record_group_decision: no workspace or fs service')
        const ledger = await fs.resolve(`${workspace}/.cicada/ledger.json`, { cwd: workspace })
        const info = await fs.stat(ledger)
        const existing = info === undefined ? '[]' : await fs.readText(ledger)
        let rows: unknown[] = []
        try {
          rows = JSON.parse(existing) as unknown[]
        } catch {
          rows = []
        }
        rows.push({ part_number: args.part_number, group_id: args.group_id, decision: args.decision, rationale: args.rationale ?? '', at: Date.now() })
        await fs.writeText(ledger, JSON.stringify(rows, null, 1), info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version })
        return ok({}, `已记录决策 ${args.part_number}/${args.group_id}。`)
      },
    }),
  ]
}

/** Producer-scoped tools (workspace copy only; registered in the producer window). */
export function producerDatasheetTools(host: { workspaceRoot(agent?: { session: { header: { cwd?: string } } }): string | undefined }): ToolDefinition[] {
  return [
    defineTool({
      name: 'design_intent_read',
      description: 'Read THIS workspace\'s knowledge landscape (`.cicada/design_intent.json`) as STRUCTURED facts: the '
        + 'confirmed request summary, the selected parts, the datasheet requests, and every functional block with its '
        + 'parameters ({name, value, binding_strength, source_kind}). Read it FIRST — it is what the design intends — then '
        + 'read the datasheet groups that carry those parts. Values: a datasheet group\'s external_components and '
        + 'operating_limits OUTRANK these parameters (they are quoted from the document), and both outrank any prose in '
        + 'your task prompt. Never invent a value the sources do not state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            schema_version: { type: 'string' },
            request: { type: 'string' },
            selected_parts: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            datasheet_requests: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            functional_blocks: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(_args: Record<string, never>, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        const workspace = host.workspaceRoot(exec.agent)
        if (workspace === undefined) throw new Error('design_intent_read: no workspace')
        const empty = { ok: false, message: '', schema_version: '', request: '', selected_parts: [], datasheet_requests: [], functional_blocks: [] }
        const file = readJson<Record<string, unknown>>(join(workspace, '.cicada', 'design_intent.json'))
        if (file === undefined) {
          return { ...empty, message: '工作区还没有 `.cicada/design_intent.json`（知识图景未产出）：先让 main 派 knowledge 产出它，不要凭任务措辞猜设计。' }
        }
        const record = file as Record<string, unknown>
        const parts = ((record.selected_parts as Record<string, unknown> | undefined)?.parts ?? []) as Record<string, unknown>[]
        const blocks = (Array.isArray(record.functional_blocks) ? record.functional_blocks : []) as Record<string, unknown>[]
        const summary = (record.user_request_summary as Record<string, unknown> | undefined)?.text
        return {
          ok: true,
          message: `图景：${String(parts.length)} 个选定件、${String(blocks.length)} 个功能块、${String(Array.isArray(record.datasheet_requests) ? record.datasheet_requests.length : 0)} 条 datasheet 需求。`,
          schema_version: String(record.schema_version ?? ''),
          request: typeof summary === 'string' ? summary : '',
          selected_parts: parts.map((part) => ({
            part_ref: String(part.part_ref ?? ''),
            part_number: String(part.part_number ?? ''),
            component_kind: String(part.component_kind ?? ''),
            role: String(part.role ?? ''),
            datasheet_required: part.datasheet_required === true,
          })),
          datasheet_requests: (Array.isArray(record.datasheet_requests) ? record.datasheet_requests : []).map((request) => {
            const item = request as Record<string, unknown>
            return { part_ref: String(item.part_ref ?? ''), part_number: String(item.part_number ?? ''), reason: String(item.reason ?? '') }
          }),
          functional_blocks: blocks.map((block) => ({
            name: String(block.name ?? block.block_id ?? ''),
            purpose: String(block.purpose ?? block.description ?? ''),
            parameters: (Array.isArray(block.parameters) ? block.parameters : []).map((parameter) => {
              const item = parameter as Record<string, unknown>
              return {
                name: String(item.name ?? ''),
                value: String(item.value ?? ''),
                binding_strength: String(item.binding_strength ?? ''),
                source_kind: String(item.source_kind ?? ''),
              }
            }),
          })),
        }
      },
    }),
    defineTool({
      name: 'datasheet_workspace_list',
      description: 'List the datasheet knowledge THIS WORKSPACE already has (never the shared library): one row per '
        + '`datasheet/<part_number>/` folder, with its index groups (group_id, title, description, pin count, and whether '
        + "that group's detail file exists) plus whether the part has a shape block. The group `description` says what "
        + "that group holds and when you need it — pick the groups your design touches, then read one with "
        + 'datasheet_workspace_read_group before placing or connecting that part.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            datasheets: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(_args: Record<string, never>, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        const workspace = host.workspaceRoot(exec.agent)
        if (workspace === undefined) throw new Error('datasheet_workspace_list: no workspace')
        // Rebuilt as fresh literals: the tool output schema is an open JSON
        // object, which a named interface is not assignable to.
        const datasheets = listWorkspaceGroups(workspace).map((row) => ({
          part_number: row.part_number,
          has_shape: row.has_shape,
          groups: row.groups.map((group) => ({
            group_id: group.group_id,
            title: group.title,
            description: group.description,
            pin_count: group.pin_count,
            has_detail: group.has_detail,
          })),
        }))
        const groups = datasheets.reduce((sum, row) => sum + row.groups.length, 0)
        return {
          ok: true,
          message: datasheets.length === 0
            ? '工作区还没有任何 datasheet 拷贝。'
            : `工作区有 ${datasheets.length} 份 datasheet 拷贝、共 ${groups} 个 index 组。`,
          datasheets,
        }
      },
    }),
    defineTool({
      name: 'datasheet_workspace_read_group',
      description: "Read ONE index group's facts from THIS workspace copy. Pass the exact part_number and a group_id "
        + 'taken from datasheet_workspace_list; the result is that group\'s pins (physical number, pin name, electrical '
        + 'type, functions), its external components (which part, what value, how it connects), its operating limits, '
        + 'its design notes and the claims they rest on. These group facts are the AUTHORITY for values and connections '
        + '(they outrank the design intent parameters and any prose summary). Read the groups your design touches right '
        + 'before placing or connecting that part — never guess pin numbers or component values.',
      parameters: {
        part_number: { type: 'string', required: true, description: 'Exact part number (the datasheet folder name).' },
        group_id: { type: 'string', required: true, description: 'Group id from datasheet_workspace_list, e.g. PIN-001.' },
        claims: { type: 'string', description: "Pass 'all' to get every claim of the group. Omit it and you get only the claims the returned pins, external components and operating limits actually cite — the payload stays small enough to reach you whole." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            part_number: { type: 'string' },
            group_id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            pins: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            design_notes: { type: 'array', items: { type: 'string' } },
            external_components: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            operating_limits: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            source_claims: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: { part_number: string; group_id: string; claims?: string }, exec: { agent?: { session: { header: { cwd?: string } } } }) {
        const workspace = host.workspaceRoot(exec.agent)
        if (workspace === undefined) throw new Error('datasheet_workspace_read_group: no workspace')
        const base = { part_number: args.part_number, group_id: args.group_id }
        const read = readWorkspaceIndexFile(workspace, args.part_number)
        if (read.state !== 'ok') {
          const why = read.state === 'absent' ? '工作区没有' : `index.json 无法使用（${read.reason}）`
          return { ok: false, message: `${why} ${args.part_number} 的 datasheet（datasheet_workspace_list 看现有清单）。`, ...base, title: '', description: '', pins: [], design_notes: [], external_components: [], operating_limits: [], source_claims: [] }
        }
        const index = read.index
        const group = index.groups.find((candidate) => candidate.group_id === args.group_id)
        if (group === undefined) {
          const available = index.groups.map((candidate) => candidate.group_id).join('、')
          return { ok: false, message: `组 ${args.group_id} 不在 ${args.part_number} 里；现有组：${available || '（无）'}。`, ...base, title: '', description: '', pins: [], design_notes: [], external_components: [], operating_limits: [], source_claims: [] }
        }
        const detail = readWorkspaceDetail(workspace, args.part_number, args.group_id)
        if (detail === undefined) {
          return { ok: false, message: `组 ${args.group_id} 只有索引、没有 detail 文件（引脚明细缺失，不能据此连线）。`, ...base, title: group.title, description: group.description ?? '', pins: [], design_notes: [], external_components: [], operating_limits: [], source_claims: claimViews(group.source_claims) }
        }
        // Rebuilt as fresh literals for the open JSON output schema.
        const pins = detail.pins.map((pin) => ({
          physical_number: String(pin.physical_number ?? ''),
          canonical_name: pin.canonical_name ?? '',
          electrical: pin.electrical ?? '',
          aliases: pin.aliases ?? [],
          functions: pinFunctionViews(pin.functions),
        }))
        // 载荷策略（2026-09-13 适配清单 P0-2）：一个 48 脚组的全部 claim 可到 2 万字符，
        // 越过 harness 剪枝阈值后模型只会拿到头尾、设计指导层被静默剪掉。默认只回**被引用**
        // 的 claim（引脚 / 外接元件 / 工作限值引到的），需要全量时显式传 claims: 'all'。
        const cited = new Set<string>()
        for (const pin of detail.pins) for (const id of pin.source_claim_ids ?? []) cited.add(String(id))
        const externalComponents = detail.external_components ?? group.external_components ?? []
        for (const item of externalComponents) for (const id of item.source_claim_ids ?? []) cited.add(String(id))
        const operatingLimits = detail.operating_limits ?? group.operating_limits ?? []
        for (const item of operatingLimits) for (const id of item.source_claim_ids ?? []) cited.add(String(id))
        const groupClaims = group.source_claims ?? []
        const claims = args.claims === 'all' ? groupClaims : groupClaims.filter((claim) => cited.has(claim.claim_id))
        // v3 设计指导层：detail 与 index 组互为镜像，谁有取谁（读侧双布局容错）。
        const payload = {
          ...base,
          title: group.title,
          description: group.description ?? detail.description ?? '',
          pins,
          design_notes: [...detail.design_notes ?? group.design_notes ?? []],
          external_components: externalComponentViews(externalComponents),
          operating_limits: operatingLimitViews(operatingLimits),
          source_claims: claimViews(claims),
        }
        return ok(payload, `${args.part_number}/${args.group_id}：${pins.length} 个引脚、${payload.external_components.length} 个外接元件、${payload.operating_limits.length} 条工作限值、${payload.source_claims.length}/${groupClaims.length} 条依据（要看全部传 claims: 'all'）。`)
      },
    }),
  ]
}

export { isValidPartName }
