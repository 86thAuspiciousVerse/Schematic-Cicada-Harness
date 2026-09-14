import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAudit } from '../src/audit.ts'
import { GlobalDatasheetDb, type DatasheetEntry } from '../src/database.ts'
import type { DatasheetDetailFile, DatasheetGroup, ShapeBlock } from '../src/schema.ts'
import { similarParts } from '../src/similar.ts'
import { mainDatasheetTools, producerDatasheetTools } from '../src/tools.ts'
import { listWorkspaceGroups, readWorkspaceDetail, readWorkspaceIndex, readWorkspaceIndexFile, readWorkspaceRootShapeBlock, workspaceDatasheetPins } from '../src/workspace.ts'
import { CicadaKnowledge } from '../src/index.ts'

const PART = 'AMS1117-3.3'

/** Pin-carrying group (owns pins 1-3) with its provenance claims. */
const PIN_GROUP: DatasheetGroup = {
  description: 'Pin definitions from the datasheet pin table: name and electrical type per physical pin.',
  group_id: 'PIN-001',
  title: 'Pin connections (SOT-223)',
  category: 'pinout',
  priority: 'required',
  brief: 'Pin functions of the fixed 3.3V version',
  location: { line_start: 12, line_end: 30, search_signature: 'PIN CONFIGURATION' },
  pins: [
    { physical_number: '1', canonical_name: 'GND', electrical: 'power_in', source_claim_ids: ['PIN-001-C1'] },
    { physical_number: '2', canonical_name: 'VOUT', electrical: 'power_out', source_claim_ids: ['PIN-001-C2'] },
    { physical_number: '3', canonical_name: 'VIN', electrical: 'power_in', source_claim_ids: ['PIN-001-C2'] },
  ],
  source_claims: [
    { claim_id: 'PIN-001-C1', source_kind: 'datasheet_text', source_ref: 'full.md:14', section: 'PIN CONFIGURATION', extracted_fact: 'Pin 1 is ground in the fixed version', verbatim_excerpt: 'Ground/Adjust', confidence: 'high' },
    { claim_id: 'PIN-001-C2', source_kind: 'datasheet_text', source_ref: 'full.md:15', section: 'PIN CONFIGURATION', extracted_fact: 'Pin 2 is VOUT, pin 3 is VIN', verbatim_excerpt: 'VOUT / VIN', confidence: 'high' },
  ],
}

/** Prose-only group: claims and notes, no pins (never owns a pin number). */
const OVERVIEW_GROUP: DatasheetGroup = {
  description: 'Device overview: family, memory sizes, supply range and package options.',
  group_id: 'DEV-001',
  title: 'Device overview',
  category: 'overview',
  priority: 'optional',
  brief: '1A low dropout regulator, fixed 3.3V version',
  pins: [],
  source_claims: [
    { claim_id: 'DEV-001-C1', source_kind: 'datasheet_text', source_ref: 'full.md:7', section: 'FEATURES', extracted_fact: 'Output current 1A', verbatim_excerpt: 'Output Current of 1A', confidence: 'high' },
  ],
}

const SHAPE: ShapeBlock = {
  name: PART,
  refPrefix: 'U',
  pins: [
    { number: '1', name: 'GND', electrical: 'power_in', side: 'bottom' },
    { number: '2', name: 'VOUT', electrical: 'power_out', side: 'right' },
    { number: '3', name: 'VIN', electrical: 'power_in', side: 'left' },
  ],
}

const detailOf = (group: DatasheetGroup): DatasheetDetailFile => ({
  part_number: PART,
  group_id: group.group_id,
  title: group.title,
  pins: group.pins,
  source_claim_ids: (group.source_claims ?? []).map((claim) => claim.claim_id),
})

const entry = (overrides: Partial<DatasheetEntry> = {}): DatasheetEntry => ({
  index: { schema_version: '2', part_number: PART, audited: true, groups: [PIN_GROUP, OVERVIEW_GROUP] },
  detail: { 'PIN-001': detailOf(PIN_GROUP) },
  fullMd: '# AMS1117-3.3\npinout...\n',
  shape: SHAPE,
  ...overrides,
})

let dir: string
let ws: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cicada-kb-'))
  ws = mkdtempSync(join(tmpdir(), 'cicada-ws-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

/** Write the hybrid three-artifact set into the workspace for `part`. */
const writeWorkspaceArtifacts = (part = PART, mutate: (entry: DatasheetEntry) => void = () => {}): void => {
  const files = entry()
  mutate(files)
  const partDir = join(ws, 'datasheet', part)
  mkdirSync(join(partDir, 'detail'), { recursive: true })
  writeFileSync(join(partDir, 'index.json'), JSON.stringify({ ...files.index, part_number: part }, null, 1))
  for (const [groupId, detail] of Object.entries(files.detail)) {
    writeFileSync(join(partDir, 'detail', `${groupId}.json`), JSON.stringify({ ...detail, group_id: groupId }, null, 1))
  }
  writeFileSync(join(partDir, 'full.md'), files.fullMd)
  if (files.shape !== undefined) writeFileSync(join(partDir, 'shape.json'), JSON.stringify(files.shape, null, 1))
}

/** Minimal in-memory `ctx.fs` face used by the copy/ledger tools. */
const memoryFs = (): { files: Map<string, string>; face: unknown } => {
  const files = new Map<string, string>()
  return {
    files,
    face: {
      resolve: (path: string) => Promise.resolve({ targetKey: path, displayPath: path }),
      writeText: (target: { targetKey: unknown }, content: string) => {
        files.set(String(target.targetKey), content)
        return Promise.resolve(undefined)
      },
      readText: (target: { targetKey: unknown }) => Promise.resolve(files.get(String(target.targetKey)) ?? ''),
      stat: (target: { targetKey: unknown }) => Promise.resolve(files.has(String(target.targetKey)) ? { version: 'v1' } : undefined),
    },
  }
}

const toolNamed = (tools: { name: string }[], name: string) => tools.find((tool) => tool.name === name)!
const execIn = (cwd: string) => ({ agent: { session: { header: { cwd } } } }) as never

describe('GlobalDatasheetDb (caller-resolved root, node:fs direct)', () => {
  it('round-trips put/get and reports the 1↔3 status', () => {
    const db = new GlobalDatasheetDb(dir)
    db.put(PART, entry())
    const got = db.get(PART)
    expect(got?.index.groups).toHaveLength(2)
    expect(got?.detail['PIN-001']?.pins).toHaveLength(3)
    expect(got?.fullMd).toContain('AMS1117')
    expect(got?.shape?.pins).toHaveLength(3)
    expect(db.statusOf(PART)).toMatchObject({ found: true, haveIndex: true, haveDetail: true, haveShape: true, groups: 2, missingDetailGroups: [] })
    expect(db.statusOf('NOPE')).toMatchObject({ found: false, haveIndex: false, haveDetail: false, haveShape: false, groups: 0 })
  })

  it('reports a partially written entry per artifact', () => {
    const db = new GlobalDatasheetDb(dir)
    db.put(PART, entry())
    rmSync(join(dir, 'datasheets', PART, 'detail', 'PIN-001.json'))
    const status = db.statusOf(PART)
    expect(status.haveDetail).toBe(false)
    expect(status.missingDetailGroups).toEqual(['PIN-001'])
  })

  it('lists the stored part numbers that carry an index', () => {
    const db = new GlobalDatasheetDb(dir)
    expect(db.parts()).toEqual([])
    db.put(PART, entry())
    db.put('NE555P', entry({ index: { schema_version: '2', part_number: 'NE555P', audited: true, groups: [PIN_GROUP, OVERVIEW_GROUP] } }))
    // 只有 index.json 的目录才是键；散落目录不算。
    mkdirSync(join(dir, 'datasheets', 'STRAY'), { recursive: true })
    expect(db.parts()).toEqual(['AMS1117-3.3', 'NE555P'])
  })

  it('uses one datasheets directory for the default knowledge root', () => {
    vi.stubEnv('CICADA_HOME', dir)
    const service = new CicadaKnowledge({} as never)
    expect(service.upsert(PART, entry()).ok).toBe(true)
    expect(readFileSync(join(dir, 'datasheets', PART, 'index.json'), 'utf8')).toContain('PIN-001')
    vi.unstubAllEnvs()
  })
})

describe('anchor audit (v2 hybrid artifacts)', () => {
  it('passes a complete entry', () => {
    expect(runAudit(entry())).toEqual({ ok: true, violations: [] })
  })

  it('v3 artifacts must anchor every claim inside its declared range', () => {
    const barePins = PIN_GROUP.pins.map(({ source_claim_ids: _drop, ...rest }) => rest)
    const group: DatasheetGroup = {
      group_id: 'PIN-001',
      title: 'Pin connections (SOT-223)',
      description: 'Pin table: physical pin numbers with names and electrical types.',
      location: { line_start: 2, line_end: 2, search_signature: 'pinout' },
      pins: barePins,
      source_claims: [{ claim_id: 'c1', source_kind: 'datasheet_text', source_ref: 'full.md:2', extracted_fact: 'pinout', verbatim_excerpt: 'pinout...' }],
    }
    const mk = (candidate: DatasheetGroup): DatasheetEntry => entry({
      index: { schema_version: '3', part_number: PART, audited: false, groups: [candidate] },
      fullMd: '# AMS1117-3.3\npinout...\n',
    })
    expect(runAudit(mk(group)).violations).toEqual([])
    // 摘录不在声明区间内
    const outside = runAudit(mk({ ...group, location: { line_start: 1, line_end: 1, search_signature: 'title' } }))
    expect(outside.violations.map((violation) => violation.field)).toContain('groups[PIN-001].source_claims[c1].verbatim_excerpt')
    // extracted_fact 不是 excerpt 的直接子串
    const unquoted = runAudit(mk({
      ...group,
      source_claims: [{ claim_id: 'c1', source_kind: 'datasheet_text', source_ref: 'full.md:2', extracted_fact: 'VIN 4.75 to 15 V', verbatim_excerpt: 'pinout...' }],
    }))
    expect(unquoted.violations.map((violation) => violation.field)).toContain('groups[PIN-001].source_claims[c1].extracted_fact')
    // 缺 location
    const noLocation = runAudit(mk({ ...group, location: undefined }))
    expect(noLocation.violations.map((violation) => violation.field)).toContain('groups[PIN-001].location')
    // 老产物（v2/0.3）不受锚点约束：同一份内容换个版本号即放行
    const legacy = entry({ index: { schema_version: '2', part_number: PART, audited: true, groups: [{ ...group, location: undefined, source_claims: [{ claim_id: 'c1', source_kind: 'datasheet_text', source_ref: 'full.md:2', extracted_fact: 'pinout' }] }] } })
    expect(runAudit(legacy).violations).toEqual([])
  })

  it('rejects a shape block that names another part (engine keys the symbol by it)', () => {
    // 缺陷 4（2026-09-13）：实测 datasheet/AMS1117-3.3/shape.json 写着 name=AMS1117，
    // 引擎就铸出 IC:AMS1117 去顶撞同名条目。发布口现在把身份不一致当违规拦下。
    const mismatched = runAudit(entry({ shape: { ...SHAPE, name: 'AMS1117' } }))
    expect(mismatched.ok).toBe(false)
    expect(mismatched.violations).toEqual([
      { field: 'shape.json.name', message: 'shape block name "AMS1117" must equal the part number "AMS1117-3.3"' },
    ])
    // 工作区审计按**请求件号**判定：索引自己也写错时同样拦下。
    const bothWrong = runAudit(entry({ index: { schema_version: '2', part_number: 'AMS1117', audited: true, groups: [PIN_GROUP, OVERVIEW_GROUP] }, shape: { ...SHAPE, name: 'AMS1117' } }), PART)
    expect(bothWrong.violations.map((violation) => violation.field)).toEqual(['shape.json.name'])
  })

  it('flags a pin owned by two groups', () => {
    const shared: DatasheetGroup = { ...PIN_GROUP, group_id: 'ELEC-001', title: 'Electrical characteristics', pins: [PIN_GROUP.pins[0]!], source_claims: PIN_GROUP.source_claims }
    const result = runAudit(entry({
      index: { schema_version: '2', part_number: PART, groups: [PIN_GROUP, shared] },
      detail: { 'PIN-001': detailOf(PIN_GROUP), 'ELEC-001': detailOf(shared) },
    }))
    expect(result.ok).toBe(false)
    expect(result.violations.some((violation) => violation.message.includes('already owned by group PIN-001'))).toBe(true)
  })

  it('flags numbering gaps, missing claims and dangling claim ids', () => {
    const gapped: DatasheetGroup = { ...PIN_GROUP, pins: [PIN_GROUP.pins[0]!, PIN_GROUP.pins[2]!] }
    const gap = runAudit(entry({ index: { part_number: PART, groups: [gapped] }, detail: { 'PIN-001': detailOf(gapped) }, shape: undefined }))
    expect(gap.violations.some((violation) => violation.message.includes('gap at 3'))).toBe(true)

    const noClaims: DatasheetGroup = { ...PIN_GROUP, source_claims: [] }
    const bare = runAudit(entry({ index: { part_number: PART, groups: [noClaims] }, detail: { 'PIN-001': detailOf(noClaims) } }))
    expect(bare.violations.some((violation) => violation.message.includes('needs at least one source claim'))).toBe(true)

    const dangling: DatasheetGroup = { ...PIN_GROUP, pins: [{ ...PIN_GROUP.pins[0]!, source_claim_ids: ['NOPE-1'] }, PIN_GROUP.pins[1]!, PIN_GROUP.pins[2]!] }
    const withDangling = runAudit(entry({ index: { part_number: PART, groups: [dangling] }, detail: { 'PIN-001': detailOf(dangling) } }))
    expect(withDangling.violations.some((violation) => violation.message.includes('source_claim_id NOPE-1'))).toBe(true)
  })

  it('flags index/detail disagreement and a missing or mismatched shape block', () => {
    const shortDetail: DatasheetDetailFile = { ...detailOf(PIN_GROUP), pins: [PIN_GROUP.pins[0]!] }
    const mismatch = runAudit(entry({ detail: { 'PIN-001': shortDetail } }))
    expect(mismatch.violations.some((violation) => violation.message.includes('pin 2 is in the index but not in the detail'))).toBe(true)

    const noShape = runAudit(entry({ shape: undefined }))
    expect(noShape.violations.some((violation) => violation.field === 'shape.json' && violation.message.includes('missing'))).toBe(true)

    const extraPin = runAudit(entry({ shape: { ...SHAPE, pins: [...SHAPE.pins, { number: '4', name: 'NC', electrical: 'passive' }] } }))
    expect(extraPin.violations.some((violation) => violation.message.includes('shape pin 4 is not in the datasheet pin universe'))).toBe(true)

    const nameless = runAudit(entry({ shape: { ...SHAPE, pins: [{ number: '1', name: '', electrical: 'power_in' }, ...SHAPE.pins.slice(1)] } }))
    expect(nameless.violations.some((violation) => violation.field === 'shape.json[1].name')).toBe(true)
  })
})

describe('shared library lane: check / copy / publish', () => {
  const serviceFor = (): CicadaKnowledge => new CicadaKnowledge({} as never, dir)

  it('copy lands index/detail/shape/full.md under datasheet/<part_number>/', async () => {
    const service = serviceFor()
    service.upsert(PART, entry())
    const { files, face } = memoryFs()
    const copy = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => '/ws', fs: () => face as never }), 'datasheet_library_copy')

    const result = await copy.execute({ part_number: PART }, {} as never) as { copied: string[]; skipped: string[]; have_shape: boolean }
    expect(result.copied).toEqual(['full.md', 'index.json', 'detail/PIN-001.json', 'shape.json'])
    expect(files.get('/ws/datasheet/AMS1117-3.3/shape.json')).toContain('power_out')
    expect(files.get('/ws/datasheet/AMS1117-3.3/detail/PIN-001.json')).toContain('VOUT')

    const again = await copy.execute({ part_number: PART }, {} as never) as { copied: string[]; skipped: string[]; message: string }
    expect(again.copied).toEqual([])
    expect(again.skipped).toHaveLength(4)
    expect(again.message).toContain('跳过已存在 4 个')
  })

  it('copy warns when the workspace copy is an older contract version', async () => {
    // 适配缺口（2026-09-13）：copy 从不覆盖 ⇒ 工作区旧 v2 产物会把库里的 v3 挡住。
    const service = serviceFor()
    // db.put 直写（V3 夹具没带锚点，会让 upsert 的审计拒掉，而本用例只测版本比较）
    service.db.put(PART, entry({ index: { schema_version: '3', part_number: PART, audited: true, groups: entry().index.groups } }))
    writeWorkspaceArtifacts() // 工作区这份是 v2
    const copy = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_copy')
    const result = await copy.execute({ part_number: PART }, execIn(ws)) as { stale: boolean; message: string }
    expect(result.stale).toBe(true)
    expect(result.message).toContain('重产')
    expect(result.message).toContain('v2')
  })

  it('check reports the three artifacts, and a miss or generic label never hits', async () => {
    const service = serviceFor()
    service.upsert(PART, entry())
    const check = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => '/ws', fs: () => memoryFs().face as never }), 'datasheet_library_check')

    const hit = await check.execute({ part_number: PART }, {} as never) as { found: boolean; have_shape: boolean; message: string }
    expect(hit.found).toBe(true)
    expect(hit.have_shape).toBe(true)
    expect(hit.message).toContain('shape=有')

    const partial = serviceFor()
    partial.db.put('LM358', { ...entry(), shape: undefined })
    const partialCheck = toolNamed(mainDatasheetTools(partial, { workspaceRoot: () => '/ws', fs: () => memoryFs().face as never }), 'datasheet_library_check')
    const noShape = await partialCheck.execute({ part_number: 'LM358' }, {} as never) as { have_shape: boolean; message: string }
    expect(noShape.have_shape).toBe(false)
    expect(noShape.message).toContain('仍需产出形状块')

    const miss = await check.execute({ part_number: 'NE555' }, {} as never) as { found: boolean; message: string; similar: unknown[] }
    expect(miss.found).toBe(false)
    expect(miss.message).toContain('派一个 datasheet 子代理')
    expect(miss.similar).toEqual([])

    // 近失（2026-09-13）：库里有 AMS1117-3.3，问 AMS1117 → 只列候选，判定仍是 miss。
    const near = await check.execute({ part_number: 'AMS1117' }, {} as never) as {
      found: boolean; similar: { part_number: string; reason: string; have_shape: boolean }[]; hint?: string
    }
    expect(near.found).toBe(false)
    expect(near.similar).toEqual([{ part_number: PART, reason: 'contains', have_index: true, have_detail: true, have_shape: true }])
    // 图景还没落地时，"先出图景"的提醒优先于近失文案。
    expect(near.hint).toContain('知识图景还没生成')

    const noWorkspace = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => undefined, fs: () => memoryFs().face as never }), 'datasheet_library_check')
    const hintOnly = await noWorkspace.execute({ part_number: 'AMS1117' }, {} as never) as { hint?: string }
    expect(hintOnly.hint).toContain('不同的件')
    expect(hintOnly.hint).toContain('datasheet_library_copy')

    const generic = await check.execute({ part_number: 'ams1117 regulator' }, {} as never) as { ok: boolean; message: string }
    expect(generic.ok).toBe(false)
    expect(generic.message).toContain('不是合法部件名')
  })

  it('publish enforces the v3 anchor rules through the workspace-declared version', async () => {
    // 回归（2026-09-13 适配清单 K1）：发布口曾把 schema_version 固定成 '2'，于是 v3 闸门
    // 在生产路径永不成立、锚点校验被 100% 绕过（旧测试只直调 runAudit，属假绿）。
    writeWorkspaceArtifacts(PART, (files) => {
      files.index.schema_version = '3'
      // 克隆：entry() 复用模块级 PIN_GROUP，直接改会污染后续用例（实测踩到）。
      files.index.groups = files.index.groups.map((candidate) => ({ ...candidate }))
      const group = files.index.groups[0]!
      group.location = { line_start: 1, line_end: 1, search_signature: 'title' }
      group.source_claims = [{ claim_id: 'c1', source_kind: 'datasheet_text', source_ref: 'full.md:2', extracted_fact: 'pinout', verbatim_excerpt: 'pinout...' }]
    })
    const publish = toolNamed(mainDatasheetTools(new CicadaKnowledge({} as never, dir), { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_publish')
    const result = await publish.execute({ part_number: PART }, execIn(ws)) as { ok: boolean; violations: { field: string }[] }
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.field)).toContain('groups[PIN-001].source_claims[c1].verbatim_excerpt')
  })

  it('publish audits the workspace artifacts and stores the entry', async () => {
    writeWorkspaceArtifacts()
    const service = serviceFor()
    const publish = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_publish')

    const result = await publish.execute({ part_number: PART }, execIn(ws)) as { ok: boolean; violations: unknown[]; message: string }
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.message).toContain('已发布')
    expect(existsSync(join(dir, 'datasheets', PART, 'index.json'))).toBe(true)
    expect(existsSync(join(dir, 'datasheets', PART, 'shape.json'))).toBe(true)
    expect(service.db.statusOf(PART)).toMatchObject({ haveIndex: true, haveDetail: true, haveShape: true })
  })

  it('publish refuses an unaudited workspace and names the violations', async () => {
    writeWorkspaceArtifacts(PART, (files) => { files.shape = undefined })
    const service = serviceFor()
    const publish = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_publish')

    const result = await publish.execute({ part_number: PART }, execIn(ws)) as { ok: boolean; violations: { field: string; message: string }[]; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('锚点审计未通过')
    expect(result.violations.some((violation) => violation.field === 'shape.json')).toBe(true)
    expect(existsSync(join(dir, 'datasheets', PART, 'index.json'))).toBe(false)
  })

  it('publish refuses a part that only exists in the library', async () => {
    const service = serviceFor()
    const publish = toolNamed(mainDatasheetTools(service, { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_publish')
    const result = await publish.execute({ part_number: 'NE555' }, execIn(ws)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('工作区没有 datasheet/NE555/index.json')
  })
})

describe('producer workspace lane: list / read_group', () => {
  it('lists what the workspace carries, including detail gaps and shape', async () => {
    writeWorkspaceArtifacts()
    rmSync(join(ws, 'datasheet', PART, 'detail', 'PIN-001.json'))
    const list = toolNamed(producerDatasheetTools({ workspaceRoot: () => ws }), 'datasheet_workspace_list')
    const result = await list.execute({}, {} as never) as { message: string; datasheets: { part_number: string; has_shape: boolean; groups: { group_id: string; pin_count: number; has_detail: boolean }[] }[] }
    expect(result.datasheets).toHaveLength(1)
    expect(result.datasheets[0]?.has_shape).toBe(true)
    expect(result.datasheets[0]?.groups).toEqual([
      { group_id: 'PIN-001', title: 'Pin connections (SOT-223)', description: 'Pin definitions from the datasheet pin table: name and electrical type per physical pin.', pin_count: 3, has_detail: false },
      { group_id: 'DEV-001', title: 'Device overview', description: 'Device overview: family, memory sizes, supply range and package options.', pin_count: 0, has_detail: false },
    ])
    expect(result.message).toContain('共 2 个 index 组')
  })


  it('read_group carries the v3 design guidance and the group claims', async () => {
    writeWorkspaceArtifacts(PART, (files) => {
      const group = files.index.groups[0]!
      group.design_notes = ['Place the 100 nF cap next to pin 2.']
      group.external_components = [{ ref_kind: 'capacitor', value: '100 nF', connection: 'VOUT to GND, close to the pin', source_claim_ids: ['c1'] }]
      group.operating_limits = [{ name: 'VIN', value: '4.75 to 15 V' }]
      group.source_claims = [{ claim_id: 'c1', source_kind: 'datasheet_text', source_ref: 'full.md:650', extracted_fact: 'VIN 4.75 to 15 V' }]
      files.detail['PIN-001']!.design_notes = ['Place the 100 nF cap next to pin 2.']
    })
    const read = toolNamed(producerDatasheetTools({ workspaceRoot: () => ws }), 'datasheet_workspace_read_group')
    const result = await read.execute({ part_number: PART, group_id: 'PIN-001' }, {} as never) as {
      description: string
      design_notes: string[]
      external_components: { ref_kind: string; value: string; connection: string; source_claim_ids: string[] }[]
      operating_limits: { name: string; value: string }[]
      source_claims: { claim_id: string }[]
      pins: { physical_number: string }[]
    }
    expect(result.description).toContain('Pin definitions')
    expect(result.design_notes).toEqual(['Place the 100 nF cap next to pin 2.'])
    expect(result.external_components).toEqual([
      { ref_kind: 'capacitor', value: '100 nF', connection: 'VOUT to GND, close to the pin', source_claim_ids: ['c1'] },
    ])
    expect(result.operating_limits).toEqual([{ name: 'VIN', value: '4.75 to 15 V', condition: '', source_claim_ids: [] }])
    expect(result.source_claims.map((claim) => claim.claim_id)).toEqual(['c1'])
    expect(result.pins).toHaveLength(3)
  })

  it('design_intent_read hands the producer the structured landscape', async () => {
    mkdirSync(join(ws, '.cicada'), { recursive: true })
    writeFileSync(join(ws, '.cicada', 'design_intent.json'), JSON.stringify({
      schema_version: '0.4',
      user_request_summary: { text: 'STM32 minimum system' },
      selected_parts: { parts: [{ part_ref: 'part_stm32', part_number: 'STM32F103C8T6', component_kind: 'microcontroller', role: '主控', datasheet_required: true }] },
      datasheet_requests: [{ part_ref: 'part_stm32', part_number: 'STM32F103C8T6', reason: 'pin map' }],
      functional_blocks: [{ name: 'power', parameters: [{ name: 'vdd_local', value: '100nF', binding_strength: 'required', source_kind: 'engineering_practice' }] }],
    }), 'utf8')
    const read = toolNamed(producerDatasheetTools({ workspaceRoot: () => ws }), 'design_intent_read')
    const result = await read.execute({}, {} as never) as {
      ok: boolean
      request: string
      selected_parts: { part_number: string; datasheet_required: boolean }[]
      functional_blocks: { parameters: { name: string; value: string; binding_strength: string; source_kind: string }[] }[]
    }
    expect(result.ok).toBe(true)
    expect(result.request).toContain('STM32')
    expect(result.selected_parts[0]).toEqual({ part_ref: 'part_stm32', part_number: 'STM32F103C8T6', component_kind: 'microcontroller', role: '主控', datasheet_required: true })
    expect(result.functional_blocks[0]?.parameters[0]).toEqual({ name: 'vdd_local', value: '100nF', binding_strength: 'required', source_kind: 'engineering_practice' })

    const empty = mkdtempSync(join(tmpdir(), 'cicada-no-landscape-'))
    const missing = await toolNamed(producerDatasheetTools({ workspaceRoot: () => empty }), 'design_intent_read').execute({}, {} as never) as { ok: boolean; message: string }
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('知识图景未产出')
  })

  it('read_group keeps the payload under the pruner ceiling by citing, not dumping, claims', async () => {
    // 适配清单 P0-2 回归：48 脚组的全量 claim 曾达 24,904 字符，越过 harness 剪枝阈值后
    // 设计指导层被静默剪掉。默认只回被引脚/外接元件/工作限值引用到的 claim。
    const pins = Array.from({ length: 48 }, (_unused, index) => ({
      physical_number: String(index + 1),
      canonical_name: `P${String(index + 1)}`,
      electrical: 'bidirectional',
      source_claim_ids: [`c${String(index + 1)}`],
    }))
    const cited = pins.map((pin, index) => ({
      claim_id: `c${String(index + 1)}`,
      source_kind: 'datasheet_text',
      source_ref: `full.md:${String(600 + index)}`,
      extracted_fact: `pin ${String(index + 1)} fact`,
      verbatim_excerpt: `pin ${String(index + 1)} verbatim excerpt from the table row`,
    }))
    const uncited = Array.from({ length: 10 }, (_unused, index) => ({
      claim_id: `x${String(index + 1)}`,
      source_kind: 'datasheet_text',
      source_ref: 'full.md:320',
      extracted_fact: 'background fact',
      verbatim_excerpt: 'a background sentence that no pin cites',
    }))
    const group = {
      group_id: 'pinout',
      title: 'Pin map',
      description: 'Every physical pin with its name, type and the function it serves.',
      pins,
      source_claims: [...cited, ...uncited],
    }
    mkdirSync(join(ws, 'datasheet', PART, 'detail'), { recursive: true })
    writeFileSync(join(ws, 'datasheet', PART, 'index.json'), JSON.stringify({ schema_version: '3', part_number: PART, groups: [group], modified_at: 1 }), 'utf8')
    writeFileSync(join(ws, 'datasheet', PART, 'detail', 'pinout.json'), JSON.stringify({ part_number: PART, group_id: 'pinout', pins }), 'utf8')
    const read = toolNamed(producerDatasheetTools({ workspaceRoot: () => ws }), 'datasheet_workspace_read_group')

    const byDefault = await read.execute({ part_number: PART, group_id: 'pinout' }, {} as never) as { source_claims: { claim_id: string }[]; pins: unknown[] }
    expect(byDefault.pins).toHaveLength(48)
    expect(byDefault.source_claims).toHaveLength(48)
    expect(byDefault.source_claims.map((claim) => claim.claim_id)).not.toContain('x1')

    const all = await read.execute({ part_number: PART, group_id: 'pinout', claims: 'all' }, {} as never) as { source_claims: { claim_id: string }[] }
    expect(all.source_claims).toHaveLength(58)

    // 默认载荷必须留在 preset 剪枝阈值（32768）之内
    expect(JSON.stringify(byDefault).length).toBeLessThan(32768)
  })

  it('resolves the workspace from the calling agent, not from a turn-scoped lookup', async () => {
    writeWorkspaceArtifacts()
    const seen: (string | undefined)[] = []
    const read = toolNamed(producerDatasheetTools({
      workspaceRoot: (agent) => {
        seen.push(agent?.session.header.cwd)
        return agent?.session.header.cwd
      },
    }), 'datasheet_workspace_read_group')
    const hit = await read.execute({ part_number: PART, group_id: 'PIN-001' }, execIn(ws)) as { ok: boolean }
    expect(hit.ok).toBe(true)
    expect(seen).toEqual([ws])
  })

  it('reports an empty workspace and names every read_group failure mode', async () => {
    const tools = producerDatasheetTools({ workspaceRoot: () => ws })
    const empty = await toolNamed(tools, 'datasheet_workspace_list').execute({}, {} as never) as { message: string; datasheets: unknown[] }
    expect(empty.datasheets).toEqual([])
    expect(empty.message).toContain('还没有任何 datasheet 拷贝')

    writeWorkspaceArtifacts()
    const read = toolNamed(producerDatasheetTools({ workspaceRoot: () => ws }), 'datasheet_workspace_read_group')
    const hit = await read.execute({ part_number: PART, group_id: 'PIN-001' }, {} as never) as { ok: boolean; pins: { physical_number: string }[] }
    expect(hit.ok).toBe(true)
    expect(hit.pins.map((pin) => pin.physical_number)).toEqual(['1', '2', '3'])

    rmSync(join(ws, 'datasheet', PART, 'detail', 'PIN-001.json'))
    const indexOnly = await read.execute({ part_number: PART, group_id: 'PIN-001' }, {} as never) as { ok: boolean; message: string }
    expect(indexOnly.ok).toBe(false)
    expect(indexOnly.message).toContain('没有 detail 文件')

    const unknownGroup = await read.execute({ part_number: PART, group_id: 'NOPE' }, {} as never) as { ok: boolean; message: string }
    expect(unknownGroup.ok).toBe(false)
    expect(unknownGroup.message).toContain('现有组：PIN-001、DEV-001')

    const unknownPart = await read.execute({ part_number: 'NE555', group_id: 'PIN-001' }, {} as never) as { ok: boolean; message: string }
    expect(unknownPart.ok).toBe(false)
    expect(unknownPart.message).toContain('工作区没有 NE555')
  })
})

describe('workspace readers', () => {
  it('reads the hybrid index/detail and builds the pin universe from details', () => {
    writeWorkspaceArtifacts()
    const index = readWorkspaceIndex(ws, PART)
    expect(index?.groups.map((group) => group.group_id)).toEqual(['PIN-001', 'DEV-001'])
    expect(readWorkspaceDetail(ws, PART, 'PIN-001')?.pins).toHaveLength(3)

    const source = workspaceDatasheetPins(ws, PART)
    expect(source?.expected).toBe(3)
    expect(source?.groups[0]?.map((pin) => `${pin.physicalNumber}:${pin.type}`)).toEqual(['1:power_in', '2:power_out', '3:power_in'])

    const summaries = listWorkspaceGroups(ws)
    expect(summaries[0]?.has_shape).toBe(true)
    expect(summaries[0]?.groups[0]).toEqual({ group_id: 'PIN-001', title: 'Pin connections (SOT-223)', description: 'Pin definitions from the datasheet pin table: name and electrical type per physical pin.', pin_count: 3, has_detail: true })
  })

  it('keeps the declared pin count when a detail is missing (incomplete, never silently smaller)', () => {
    writeWorkspaceArtifacts()
    rmSync(join(ws, 'datasheet', PART, 'detail', 'PIN-001.json'))
    const source = workspaceDatasheetPins(ws, PART)
    expect(source?.expected).toBe(3)
    expect(source?.groups[0]).toEqual([])
    expect(readWorkspaceIndex(ws, 'MISSING')).toBeUndefined()
    expect(workspaceDatasheetPins(ws, 'MISSING')).toBeUndefined()
  })

  it('M1e-1 shape block reads: datasheet/<part>/ first, workspace root fallback with name guard', () => {
    mkdirSync(join(ws, 'datasheet', 'AMS1117'), { recursive: true })
    writeFileSync(join(ws, 'datasheet', 'AMS1117', 'shape.json'), JSON.stringify({ name: 'AMS1117', pins: [] }))
    writeFileSync(join(ws, 'shape.json'), JSON.stringify({ name: 'AMS1117', pins: [] }))
    expect(readWorkspaceRootShapeBlock(ws, 'AMS1117')?.name).toBe('AMS1117')
    writeFileSync(join(ws, 'shape.json'), JSON.stringify({ name: 'NE555', pins: [] }))
    expect(readWorkspaceRootShapeBlock(ws, 'AMS1117')).toBeUndefined()
    // A shape file without a pins array is not a shape block.
    writeFileSync(join(ws, 'datasheet', 'AMS1117', 'shape.json'), JSON.stringify({ name: 'AMS1117' }))
    expect(listWorkspaceGroups(ws).find((row) => row.part_number === 'AMS1117')).toBeUndefined()
  })
})

describe('legacy v0.3 artifacts (a model that finds old examples tends to copy them)', () => {
  /** `indexes[]` + `pins_summary` + object-typed `electrical`, as the v0.3 pipeline wrote. */
  const writeLegacy = (): void => {
    const partDir = join(ws, 'datasheet', PART)
    mkdirSync(join(partDir, 'detail'), { recursive: true })
    writeFileSync(join(partDir, 'index.json'), JSON.stringify({
      indexes: [
        {
          part_number: PART,
          group_id: 'PIN-001',
          title: 'Pin connections (SOT-223)',
          description: 'Legacy v0.3 pin table: every physical pin with its name and electrical type.',
          category: 'pinout',
          priority: 'required',
          brief: 'Pin functions of the fixed 3.3V version',
          pins_summary: [{ physical_number: 1, canonical_name: 'GND', electrical: { direction: 'passive', pin_type: 'ground' } }],
          source_claims: [{ claim_id: 'PIN-001-C1', source_kind: 'datasheet_text', source_ref: 'full.md:14', extracted_fact: 'Pin 1 is ground', confidence: 'high' }],
        },
        {
          part_number: PART,
          group_id: 'DEV-001',
          title: 'Device overview',
          description: 'Legacy v0.3 device overview: family, memory, supply range and package.',
          pins_summary: [],
          source_claims: [{ claim_id: 'DEV-001-C1', source_kind: 'datasheet_text', source_ref: 'full.md:7', extracted_fact: '1A LDO', confidence: 'high' }],
        },
      ],
    }), 'utf8')
    writeFileSync(join(partDir, 'detail', 'PIN-001.json'), JSON.stringify({
      part_number: PART,
      group_id: 'PIN-001',
      title: 'Pin connections (SOT-223)',
      pins: [{ pin_id: 'PIN-001_P1', physical_number: 1, canonical_name: 'GND', electrical: { direction: 'passive', pin_type: 'ground' } }],
    }), 'utf8')
    writeFileSync(join(partDir, 'shape.json'), JSON.stringify({ name: PART, refPrefix: 'U', pins: [{ number: '1', name: 'GND', electrical: 'power_in', side: 'bottom' }] }), 'utf8')
    writeFileSync(join(partDir, 'full.md'), '# AMS1117-3.3\n', 'utf8')
  }

  it('normalizes the legacy shapes on read', () => {
    writeLegacy()
    const index = readWorkspaceIndex(ws, PART)
    expect(index?.groups.map((group) => group.group_id)).toEqual(['PIN-001', 'DEV-001'])
    expect(index?.groups[0]?.pins).toEqual([{ physical_number: '1', canonical_name: 'GND', electrical: 'ground' }])
    expect(readWorkspaceDetail(ws, PART, 'PIN-001')?.pins).toEqual([{ physical_number: '1', canonical_name: 'GND', electrical: 'ground' }])
    expect(workspaceDatasheetPins(ws, PART)?.expected).toBe(1)
    expect(listWorkspaceGroups(ws)[0]?.groups[0]).toMatchObject({ group_id: 'PIN-001', pin_count: 1, has_detail: true })
  })

  it('publishes real legacy artifacts once normalized', async () => {
    writeLegacy()
    const publish = toolNamed(mainDatasheetTools(new CicadaKnowledge({} as never, dir), { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_publish')
    const result = await publish.execute({ part_number: PART }, execIn(ws)) as { ok: boolean; violations: unknown[]; message: string }
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.message).toContain('已发布')
  })

  it('distinguishes a present-but-unusable index from a missing one', async () => {
    const partDir = join(ws, 'datasheet', PART)
    mkdirSync(partDir, { recursive: true })
    writeFileSync(join(partDir, 'index.json'), JSON.stringify({ schema_version: '9', parts: [] }), 'utf8')
    expect(readWorkspaceIndexFile(ws, PART)).toEqual({ state: 'invalid', reason: '没有 groups[]（v2）或 indexes[]（v0.3）数组' })

    const publish = toolNamed(mainDatasheetTools(new CicadaKnowledge({} as never, dir), { workspaceRoot: () => ws, fs: () => memoryFs().face as never }), 'datasheet_library_publish')
    const result = await publish.execute({ part_number: PART }, execIn(ws)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('存在但无法使用')
    expect(result.message).not.toContain('工作区没有')

    rmSync(join(partDir, 'index.json'))
    const missing = await publish.execute({ part_number: PART }, execIn(ws)) as { ok: boolean; message: string }
    expect(missing.message).toContain('工作区没有')
  })
})

describe('datasheet_library_check ordering hint', () => {
  const serviceFor = (): CicadaKnowledge => new CicadaKnowledge({} as never, dir)

  it('reminds the caller to produce the landscape first when it is missing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cicada-hint-'))
    try {
      const check = toolNamed(mainDatasheetTools(serviceFor(), {
        workspaceRoot: () => workspace,
        fs: () => memoryFs().face as never,
      }), 'datasheet_library_check')
      const result = await check.execute({ part_number: 'STM32F103C8T6' }, {} as never) as { hint?: string }
      expect(result.hint).toContain('design_intent.json')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('stays quiet once a landscape exists', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cicada-hint-'))
    try {
      mkdirSync(join(workspace, '.cicada'), { recursive: true })
      writeFileSync(join(workspace, '.cicada', 'design_intent.json'), JSON.stringify({
        selected_parts: { parts: [] }, datasheet_requests: [], evidence: [],
      }))
      const check = toolNamed(mainDatasheetTools(serviceFor(), {
        workspaceRoot: () => workspace,
        fs: () => memoryFs().face as never,
      }), 'datasheet_library_check')
      const result = await check.execute({ part_number: 'STM32F103C8T6' }, {} as never) as { hint?: string }
      expect(result.hint).toBeUndefined()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('audit: shape pin side vocabulary', () => {
  it('flags a side the engine cannot accept, naming the pin and the rule', () => {
    const bad = runAudit(entry({ shape: { ...SHAPE, pins: SHAPE.pins.map((pin, index) => (index === 0 ? { ...pin, side: 'L' } : pin)) } }))
    const violation = bad.violations.find((candidate) => candidate.field.endsWith('.side'))
    expect(violation?.message).toContain('left/right/top/bottom')
  })

  it('accepts the canonical sides (and an absent one)', () => {
    const ok = runAudit(entry({ shape: { ...SHAPE, pins: SHAPE.pins.map((pin, index) => (index === 0 ? { ...pin, side: 'top' } : pin)) } }))
    expect(ok.violations.some((candidate) => candidate.field.endsWith('.side'))).toBe(false)
  })
})

describe('near-miss ranking (library part numbers)', () => {
  it('ranks identity, containment, shared prefix, then spelling distance', () => {
    const stored = ['AMS1117-3.3', 'STM32F103C8T6', 'STM32F103C8T6TR', 'NE555P', 'LM358']
    // 大小写/标点差异 = 同一件的另一种写法，排最前。
    expect(similarParts('ams1117 3.3', stored)[0]).toEqual({ part_number: 'AMS1117-3.3', reason: 'case-or-punctuation' })
    // 包含关系次之：短的那个更接近查询。
    expect(similarParts('STM32F103C8T6', stored)[0]).toEqual({ part_number: 'STM32F103C8T6TR', reason: 'contains' })
    // 共享前缀再其次（中段不同、互不包含）。
    expect(similarParts('STM32F103C8T6', ['STM32F103RCT6'])).toEqual([{ part_number: 'STM32F103RCT6', reason: 'shares-prefix' }])
    // 拼写距离兜底（一个字符之差）。
    expect(similarParts('LM358', ['LM258'])).toEqual([{ part_number: 'LM258', reason: 'near-spelling' }])
  })

  it('never returns the exact key, and drops unrelated or too-short matches', () => {
    expect(similarParts('LM358', ['LM358', 'LM358N'])).toEqual([{ part_number: 'LM358N', reason: 'contains' }])
    expect(similarParts('LM358', ['STM32F103C8T6', 'NE555P'])).toEqual([])
    // 共同前缀太短（<4）不算线索，避免把半个库倒给模型。
    expect(similarParts('STM32F103C8', ['STM8S003F3'])).toEqual([])
  })
})
