/**
 * `verify:cicada` — Schematic-Cicada P1 gate runner (G0/G1 now; G2-G7 stubs).
 *
 * G0 environment: package skeletons exist, no hardcoded machine paths in
 * `packages/cicada/<pkg>/src`.
 * G1 golden samples: roundtrip semantic stability, fail-closed negatives,
 * deriver golden nets, and the kicad-cli oracle comparison (sexpr netlist
 * readback equals our derived nets). The oracle is configured via
 * `CICADA_KICAD_CLI` (or `--kicad-cli`); when unset the oracle half is SKIP
 * (with a warning) and never fails the rest.
 *
 * All paths are resolved from the repo root; nothing hardcoded.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { FormatError, parse, parseSexpr, serialize, validate } from '../packages/cicada/cicada-format/src/index.ts'
import { derive } from '../packages/cicada/cicada-deriver/src/view.ts'
import type { Net } from '../packages/cicada/cicada-deriver/src/types.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_GLOB_DIRS = [
  'packages/cicada/cicada-format/src',
  'packages/cicada/cicada-deriver/src',
  'packages/cicada/cicada-symbols/src',
  'packages/cicada/cicada-runtime/src',
  'packages/cicada/cicada-knowledge/src',
  'packages/cicada/cicada-mineru/src',
  'packages/cicada/cicada-erc/src',
  'packages/cicada/cicada-launcher/src',
  'packages/cicada/cicada-launcher/bin',
  'packages/cicada/cicada-editor-bridge/src',
]
const FIXTURES_DIR = join(ROOT, 'packages/cicada/cicada-format/tests/fixtures')
const FORBIDDEN_PATH = /(C:\\|\/mnt\/|\/home\/|\/Users\/)/

interface GateResult {
  id: string
  name: string
  status: 'PASS' | 'FAIL' | 'SKIP'
  details: string[]
}

const results: GateResult[] = []

function record(id: string, name: string, status: GateResult['status'], details: string[]): void {
  results.push({ id, name, status, details })
  console.log(`  ${status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️'} [${id}] ${name}`)
  for (const line of details) console.log(`     ${line}`)
}

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

// ── G0 ────────────────────────────────────────────────────────────────────
function g0(): void {
  console.log('\nG0 环境 / 路径门禁')
  const issues: string[] = []
  for (const dir of SRC_GLOB_DIRS) {
    if (!existsSync(join(ROOT, dir))) issues.push(`missing src dir: ${dir}`)
  }
  const hits: string[] = []
  for (const dir of SRC_GLOB_DIRS) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const file of walkTs(abs)) {
      const text = readFileSync(file, 'utf8')
      const match = FORBIDDEN_PATH.exec(text)
      if (match) hits.push(`${relative(ROOT, file)}: ${match[0]}`)
    }
  }
  for (const hit of hits) issues.push(`hardcoded machine path: ${hit}`)
  record('G0.1', 'package skeletons + no hardcoded paths', issues.length === 0 ? 'PASS' : 'FAIL', issues)
}

// ── G1 helpers ────────────────────────────────────────────────────────────
function netMembersKey(net: Net): string {
  return net.members.map((m) => `${m.refdes}.${m.physicalNumber}`).sort().join(',')
}

interface KicadNet {
  name: string
  members: string[]
}

function parseNetlist(text: string): KicadNet[] {
  const root = parseSexpr(text)
  const netsNode = root.children.find((c): c is { head: string; children: never[] } => (c as { head?: string }).head === 'nets')
  const nets: KicadNet[] = []
  const children = (netsNode as { children: unknown[] } | undefined)?.children ?? []
  for (const item of children as { head?: string; children: unknown[] }[]) {
    if (item?.head !== 'net') continue
    let name = ''
    const members: string[] = []
    for (const child of item.children as { head?: string; children: unknown[] }[]) {
      if (!child || typeof child !== 'object') continue
      if (child.head === 'name') {
        const leaf = (child.children as { type?: string; value?: string }[])[0]
        if (leaf?.value !== undefined) name = leaf.value
      } else if (child.head === 'node') {
        let ref = ''
        let pin = ''
        for (const sub of child.children as { head?: string; children: unknown[] }[]) {
          if (!sub || typeof sub !== 'object') continue
          const leaf = (sub.children as { type?: string; value?: string }[])[0]
          if (!leaf || leaf.value === undefined) continue
          if (sub.head === 'ref') ref = leaf.value
          if (sub.head === 'pin') pin = leaf.value
        }
        if (ref && pin) members.push(`${ref}.${pin}`)
      }
    }
    nets.push({ name, members: members.sort() })
  }
  return nets
}

function runKicad(exe: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 60_000 })
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function g1Golden(): void {
  console.log('\nG1 金样 roundtrip + fail-closed + deriver 黄金网')
  const details: string[] = []
  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.cicada_sch'))
    .sort()
  const problems: string[] = []
  const models: Record<string, ReturnType<typeof parse>> = {}

  for (const file of fixtureFiles) {
    const path = join(FIXTURES_DIR, file)
    const text = readFileSync(path, 'utf8')
    const model = parse(text)
    models[file] = model
    const valid = validate(model)
    if (!valid.ok) problems.push(`${file}: validate ${valid.errors.map((e) => e.code).join(',')}`)
    const text2 = serialize(model)
    const model2 = parse(text2)
    if (!isDeepStrictEqual(model2, model)) problems.push(`${file}: roundtrip semantic mismatch`)
    const text3 = serialize(model2)
    if (text3 !== text2) problems.push(`${file}: roundtrip not idempotent`)
  }

  for (const [text, label] of [
    ['(kicad_sch (version 20250114) (bus (pts (xy 0 0) (xy 1 1))))', 'bus top-level'],
    ['(kicad_sch (version 20250114) (symbol (lib_id "cicada:R") (at 0 0 0) (mirror x)))', 'mirror inside symbol'],
  ] as const) {
    try {
      parse(text)
      problems.push(`fail-closed: did not throw for ${label}`)
    } catch (error) {
      if (!(error instanceof FormatError) || error.code !== 'symbol_unsupported') {
        problems.push(`fail-closed: wrong error for ${label}: ${error}`)
      }
    }
  }

  /** 取一个必需夹具；缺失就响亮失败（noUncheckedIndexedAccess 下索引结果可能 undefined）。 */
const fixture = <T>(all: Record<string, T>, name: string): T => {
  const value = all[name]
  if (value === undefined) throw new Error(`verify-cicada: fixture ${name} is missing`)
  return value
}

const expected: Record<string, Net[]> = {}
  {
    const minimal = fixture(models, 'minimal.cicada_sch')
    expected['minimal.cicada_sch'] = derive(minimal).nets
    const corrected = fixture(models, 'corrected.cicada_sch')
    expected['corrected.cicada_sch'] = derive(corrected).nets
    const rot = fixture(models, 'rot90a.cicada_sch')
    expected['rot90a.cicada_sch'] = derive(rot).nets
  }
  const gold: Record<string, { name: string; members: string[] }[]> = {
    'minimal.cicada_sch': [{ name: 'NET1', members: ['C1.2'] }],
    'corrected.cicada_sch': [{ name: 'NET1', members: ['C1.1', 'R1.2'] }],
    'rot90a.cicada_sch': [{ name: 'NETX', members: ['R1.1'] }],
  }
  for (const [file, nets] of Object.entries(gold)) {
    const derived = expected[file] ?? []
    const mapped = derived.map((n) => ({ name: n.name, members: netMembersKey(n).split(',') }))
    if (JSON.stringify(mapped) !== JSON.stringify(nets)) {
      problems.push(`${file}: golden net mismatch ${JSON.stringify(mapped)}`)
    }
  }

  details.push(...problems)
  record('G1.1', `roundtrip + fail-closed + golden nets (${fixtureFiles.length} fixtures)`, problems.length === 0 ? 'PASS' : 'FAIL', details)
}

function g1Oracle(): void {
  console.log('\nG1 kicad-cli oracle 对拍')
  const cli = process.env.CICADA_KICAD_CLI
  if (!cli || !existsSync(cli)) {
    record('G1.2', 'kicad-cli netlist 对拍 (CICADA_KICAD_CLI)', 'SKIP', ['未配置 CICADA_KICAD_CLI（或路径不存在）；对拍被跳过，其余断言不受影响'])
    return
  }
  // Windows exe invoked from WSL needs `C:/...` args and a Windows-visible tmp dir.
  const isWindowsExe = cli.includes('/mnt/c/') || /^[A-Za-z]:[\\/]/.test(cli) || process.platform === 'win32'
  const rootMount = /^\/mnt\/([a-z])\/(.*)$/.exec(ROOT)
  const mountDrive = rootMount?.[1]
  const mountTail = rootMount?.[2]
  const toExePath = (p: string): string => {
    if (!isWindowsExe || mountDrive === undefined || mountTail === undefined) return p
    if (!p.startsWith(ROOT)) return p.replace(/\\/g, '/')
    return `${mountDrive.toUpperCase()}:/${mountTail}${p.slice(ROOT.length)}`.replace(/\/+/g, '/')
  }
  const tmpBase = isWindowsExe ? join(ROOT, 'node_modules', '.cicada-verify') : tmpdir()
  mkdirSync(tmpBase, { recursive: true })
  const problems: string[] = []
  const details: string[] = []
  const tmp = mkdtempSync(join(tmpBase, 'oracle-'))
  try {
    for (const file of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.cicada_sch')).sort()) {
      const source = readFileSync(join(FIXTURES_DIR, file), 'utf8')
      const model = parse(source)
      const exportPath = join(tmp, file.replace(/\.cicada_sch$/, '.kicad_sch'))
      writeFileSync(exportPath, serialize(model))
      const netlistPath = join(tmp, file.replace(/\.cicada_sch$/, '.netlist'))
      const run = runKicad(cli, ['sch', 'export', 'netlist', toExePath(exportPath), '-o', toExePath(netlistPath)])
      if (!run.ok) {
        problems.push(`${file}: kicad-cli exit non-zero: ${run.err.trim().slice(0, 200)}`)
        continue
      }
      const kicadNets = parseNetlist(readFileSync(netlistPath, 'utf8'))
      const derived = derive(model).nets
      const kicadByName = new Map<string, KicadNet>()
      for (const net of kicadNets) {
        if (net.name.startsWith('unconnected-')) continue
        kicadByName.set(net.name.replace(/^\//, ''), net)
      }
      for (const net of derived) {
        const kicad = kicadByName.get(net.name)
        if (!kicad) {
          problems.push(`${file}: deriver net ${net.name} missing in KiCad netlist`)
          continue
        }
        const derivedMembers = net.members.map((m) => `${m.refdes}.${m.physicalNumber}`).sort()
        if (JSON.stringify(derivedMembers) !== JSON.stringify(kicad.members)) {
          problems.push(`${file}: net ${net.name} members differ (deriver=${derivedMembers.join(',')} kicad=${kicad.members.join(',')})`)
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  details.push(...problems)
  record('G1.2', 'kicad-cli netlist 对拍', problems.length === 0 ? 'PASS' : 'FAIL', details.length ? details : [`oracle=${cli} 全部一致`])
}

function g2(): void {
  console.log('\nG2 组合层（bundle / patch / 组级文档）静态检查')
  const problems: string[] = []
  const bundle = join(ROOT, 'packages/bundle/cicada-app')
  const agPath = join(ROOT, 'packages/cicada/AGENTS.md')
  const groupReadme = join(ROOT, 'packages/cicada/README.md')
  const patchPath = join(bundle, 'cordis.patch.yml')
  const pkgPath = join(bundle, 'package.json')
  if (!existsSync(patchPath)) problems.push('missing bundle/cicada-app/cordis.patch.yml')
  if (!existsSync(pkgPath)) problems.push('missing bundle/cicada-app/package.json')
  if (!existsSync(agPath)) problems.push('missing packages/cicada/AGENTS.md')
  if (!existsSync(groupReadme)) problems.push('missing packages/cicada/README.md')
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8')
    for (const needle of ['ctx.webStartup.port ?? 3123', '@deepseek-ai/dsh-cicada-format', '@deepseek-ai/dsh-cicada-deriver', '@deepseek-ai/dsh-cicada-symbols']) {
      if (!patch.includes(needle)) problems.push(`patch missing: ${needle}`)
    }
  }
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; exports?: Record<string, unknown>; dependencies?: Record<string, string> }
      if (pkg.name !== '@deepseek-ai/dsh-cicada-app') problems.push(`bundle name: ${pkg.name}`)
      if (!pkg.exports?.['./cordis.patch.yml']) problems.push('bundle exports missing ./cordis.patch.yml')
      const deps = pkg.dependencies ?? {}
      if (!(deps['@deepseek-ai/dsh-cicada-format'] && deps['@deepseek-ai/dsh-cicada-deriver'] && deps['@deepseek-ai/dsh-cicada-symbols'])) problems.push('bundle dependencies missing cicada packages')
    } catch (error) {
      problems.push(`bundle package.json unparsable: ${error}`)
    }
  }
  record('G2.1', 'bundle + patch + cicada 组文档', problems.length === 0 ? 'PASS' : 'FAIL', problems)
  record('G2.2', 'profile 首启初始化 + preset（P2b）', 'SKIP', ['launcher 首启写 $DSH_HOME/profiles/cicada/ 与 preset 定稿后填充'])
}

// ── G3 ────────────────────────────────────────────────────────────────────
const WRITE_TOOL_NAMES = ['place_symbol', 'connect_pins', 'place_label', 'place_power_symbol', 'place_no_connect', 'disconnect', 'set_property', 'remove_component']
const ERROR_CODES_SPEC = [
  'duplicate_refdes', 'unknown_refdes', 'unknown_pin', 'endpoint_resolution_failed', 'connected_endpoint',
  'duplicate_endpoint', 'endpoint_not_connected', 'endpoint_in_multiple_nets', 'too_few_endpoints',
  'no_connect_conflict', 'no_connect_missing', 'cross_network_conflict', 'duplicate_net_name', 'unknown_net',
  'expected_net_mismatch', 'net_role_compare_failed', 'net_role_conflict', 'symbol_unsupported',
  'datasheet_missing', 'path_not_found', 'pin_universe_incomplete',
]

function g3(): void {
  console.log('\nG3 语义核心（runtime 8 工具 · 事务/CAS/oplog · 作用域注入）')
  const problems: string[] = []
  const runtimeSrc = join(ROOT, 'packages/cicada/cicada-runtime/src')
  for (const file of ['errors.ts', 'tools.ts', 'file-model.ts', 'ops.ts', 'turn.ts', 'roles.ts', 'index.ts']) {
    if (!existsSync(join(runtimeSrc, file))) problems.push(`missing runtime src/${file}`)
  }

  // G3.1: error-code single authority (4-spec §5.3, exactly 21 codes).
  const errorsText = existsSync(join(runtimeSrc, 'errors.ts')) ? readFileSync(join(runtimeSrc, 'errors.ts'), 'utf8') : ''
  for (const code of ERROR_CODES_SPEC) {
    if (!errorsText.includes(`'${code}'`)) problems.push(`error code missing in errors.ts: ${code}`)
  }
  const declaredCount = (errorsText.match(/^  '[a-z_]+',$/gm) ?? []).length
  if (declaredCount !== ERROR_CODES_SPEC.length) problems.push(`errors.ts declares ${declaredCount} codes, spec wants ${ERROR_CODES_SPEC.length}`)

  // G3.2: the eight write tools exist in the schema single authority.
  const toolsText = existsSync(join(runtimeSrc, 'tools.ts')) ? readFileSync(join(runtimeSrc, 'tools.ts'), 'utf8') : ''
  for (const name of WRITE_TOOL_NAMES) {
    if (!toolsText.includes(`name: '${name}'`)) problems.push(`write tool missing in tools.ts: ${name}`)
  }
  // Producer-side scoping: the deny list hides main-side tools from the producer.
  const rolesText = existsSync(join(runtimeSrc, 'roles.ts')) ? readFileSync(join(runtimeSrc, 'roles.ts'), 'utf8') : ''
  for (const name of ['query_datasheet_database', 'fetch_datasheet_to_workspace', 'mineru_extract', 'record_group_decision', 'subagent']) {
    if (!rolesText.includes(`'${name}'`)) problems.push(`producer deny list missing: ${name}`)
  }
  const runtimeIndexText = existsSync(join(runtimeSrc, 'index.ts')) ? readFileSync(join(runtimeSrc, 'index.ts'), 'utf8') : ''
  if (!runtimeIndexText.includes("export const inject = ['fs', 'cicadaFormat', 'cicadaKnowledge']")) {
    problems.push('runtime inject must depend on cicadaKnowledge before apply reads it')
  }

  // G3.3: bundle + preset wiring carries the P3 rows.
  const patchPath = join(ROOT, 'packages/bundle/cicada-app/cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  for (const name of ['@deepseek-ai/dsh-cicada-runtime', '@deepseek-ai/dsh-cicada-knowledge', '@deepseek-ai/dsh-cicada-mineru', '@deepseek-ai/dsh-cicada-erc', 'providerName: cicada-producer']) {
    if (!patch.includes(name)) problems.push(`bundle patch missing: ${name}`)
  }
  const presetPath = join(ROOT, 'packages/preset/agent-presets/presets/cicada/agent.cordis.yml')
  const preset = existsSync(presetPath) ? readFileSync(presetPath, 'utf8') : ''
  for (const name of ['provider: cicada-producer', 'toolName: spawn_producer', 'maxDepth: 1']) {
    if (!preset.includes(name)) problems.push(`cicada preset missing: ${name}`)
  }

  // G3.4: the semantic-core + P4 client test suites run green (spawnSync,
  // shell-free). Run in two batches: the jsdom client workers cold-start slow
  // on shared disks, and a combined run lets them time out the 60s fork
  // handshake under memory contention.
  const vitestShim = join(ROOT, 'node_modules', '.bin', 'vitest')
  const vitest = process.platform === 'win32'
    ? join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
    : vitestShim
  const runBatch = (targets: string[]): { ok: boolean; count: string | undefined } => {
    if (!existsSync(vitest)) {
      problems.push('vitest binary missing (pnpm install required)')
      return { ok: false, count: undefined }
    }
    const command = process.platform === 'win32' ? process.execPath : vitest
    const common = ['run', ...targets, '--reporter=dot', '--maxWorkers=4']
    const commandArgs = process.platform === 'win32' ? [vitest, ...common] : common
    const run = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 600_000, shell: false })
    const out = run.stdout ?? ''
    const failedCount = /Tests\s+(\d+) failed/.exec(out)?.[1]
    const totalMatch = /Tests\s+(\d+) passed/.exec(out)?.[1]
    if (run.status !== 0 || (failedCount !== undefined && failedCount !== '0')) {
      problems.push(`vitest run ${targets.join(' ')} failed (${failedCount ?? '?'} failed of ${totalMatch ?? '?'}); see output above`)
      return { ok: false, count: totalMatch }
    }
    return { ok: true, count: totalMatch }
  }
  const core = runBatch(['packages/cicada'])
  // One spawn per client package: three concurrent jsdom workers blow the
  // fork handshake under memory contention on shared disks.
  const layout = runBatch(['packages/client/ui-cicada-layout'])
  const pipeline = runBatch(['packages/client/ui-cicada-pipeline'])
  const canvas = runBatch(['packages/client/ui-cicada-canvas'])
  if (core.ok) problems.push(`ok: ${core.count ?? '?'} tests passed (cicada core)`)
  if (layout.ok) problems.push(`ok: ${layout.count ?? '?'} tests passed (P4 layout)`)
  if (pipeline.ok) problems.push(`ok: ${pipeline.count ?? '?'} tests passed (P4 pipeline)`)
  if (canvas.ok) problems.push(`ok: ${canvas.count ?? '?'} tests passed (P4 canvas)`)

  const pass = problems.filter((p) => !p.startsWith('ok:'))
  const details = pass.length === 0 ? problems.filter((p) => p.startsWith('ok:')) : pass
  record('G3.1', '错误码单一权威 + 8 工具 schema + 作用域 deny 清单 + 全套件 vitest', pass.length === 0 ? 'PASS' : 'FAIL', details)
}

function g3Summary(): void {
  console.log('\nG3 关口（P3 完成后）')
  record('G3', 'runtime 工具面 · 事务/CAS/oplog · 作用域注入', 'PASS', ['G3 已填充；G4 见下'])
}

function g4(): void {
  console.log('\nG4 client 三包（四区呈现 · 管线卡片流 · 三处登记）')
  const problems: string[] = []
  const clients = ['ui-cicada-layout', 'ui-cicada-pipeline', 'ui-cicada-canvas']

  // G4.1a: the three packages exist with the minimal skeleton files.
  for (const dir of clients) {
    const root = join(ROOT, 'packages/client', dir)
    for (const file of ['package.json', 'tsconfig.json', 'tsdown.config.ts', 'src/index.ts', 'src/invariant.ts', 'src/client/index.ts', 'src/client/locales.ts']) {
      if (!existsSync(join(root, file))) problems.push(`missing ${dir}/${file}`)
    }
  }

  // G4.1b: the three registration surfaces carry the three packages.
  const tsconfigClient = existsSync(join(ROOT, 'tsconfig.client.json')) ? readFileSync(join(ROOT, 'tsconfig.client.json'), 'utf8') : ''
  for (const dir of clients) {
    if (!tsconfigClient.includes(`packages/client/${dir}`)) problems.push(`tsconfig.client.json missing reference: ${dir}`)
  }
  const patchPath = join(ROOT, 'packages/bundle/cicada-app/cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  for (const name of ['@deepseek-ai/dsh-client-ui-cicada-layout', '@deepseek-ai/dsh-client-ui-cicada-pipeline', '@deepseek-ai/dsh-client-ui-cicada-canvas']) {
    if (!patch.includes(name)) problems.push(`bundle patch missing dsh.client row: ${name}`)
  }
  // The native layout is disabled by id, never deleted.
  const layoutRow = /- id: ui-layout[\s\S]*?disabled: true/.exec(patch)
  if (!layoutRow) problems.push('bundle patch must disable ui-layout (by id, disabled: true)')
  const bundleJson = existsSync(join(ROOT, 'packages/bundle/cicada-app/package.json')) ? readFileSync(join(ROOT, 'packages/bundle/cicada-app/package.json'), 'utf8') : ''
  for (const name of ['@deepseek-ai/dsh-client-ui-cicada-layout', '@deepseek-ai/dsh-client-ui-cicada-pipeline', '@deepseek-ai/dsh-client-ui-cicada-canvas']) {
    if (!bundleJson.includes(name)) problems.push(`bundle package.json missing dependency: ${name}`)
  }

  // G4.1c: the cicada frame re-declares the four native slots + two cicada slots.
  const layoutClient = existsSync(join(ROOT, 'packages/client/ui-cicada-layout/src/client/index.ts')) ? readFileSync(join(ROOT, 'packages/client/ui-cicada-layout/src/client/index.ts'), 'utf8') : ''
  for (const slot of ['sidebar', 'conversation', 'details', 'shell.overlay', 'cicada.pipeline', 'cicada.canvas']) {
    if (!layoutClient.includes(`'${slot}'`)) problems.push(`cicada-layout missing slot declaration: ${slot}`)
  }
  // G4.1d: the pipeline subscribes the session event source at the object layer.
  const pipelineClient = existsSync(join(ROOT, 'packages/client/ui-cicada-pipeline/src/client/index.ts')) ? readFileSync(join(ROOT, 'packages/client/ui-cicada-pipeline/src/client/index.ts'), 'utf8') : ''
  for (const token of ['sessions', 'eventSource', 'subscribe']) {
    if (!pipelineClient.includes(token)) problems.push(`cicada-pipeline missing ${token}`)
  }
  // G4.1e: locale namespaces are distinct per package (registered in each apply).
  const canvasClient = existsSync(join(ROOT, 'packages/client/ui-cicada-canvas/src/client/index.ts')) ? readFileSync(join(ROOT, 'packages/client/ui-cicada-canvas/src/client/index.ts'), 'utf8') : ''
  const nsChecks: [string, string][] = [
    ['cicada.layout', layoutClient],
    ['cicada.pipeline', pipelineClient],
    ['cicada.canvas', canvasClient],
  ]
  for (const [ns, text] of nsChecks) {
    if (!text.includes(ns)) problems.push(`locale namespace missing: ${ns}`)
  }

  const pass = problems.filter((p) => !p.startsWith('ok:'))
  const details = pass.length === 0
    ? ['client 三包 + 三处登记 + 槽声明 + 订阅落地 + locales 齐备；动态判据（四区呈现/卡片可见）需 dev 实例冒烟，留 G7']
    : pass
  record('G4.1', '三包存在 + 三处登记 + 子槽声明 + pipeline 订阅 + locale 命名空间', pass.length === 0 ? 'PASS' : 'FAIL', details)
}

function g4Summary(): void {
  console.log('\nG4 关口（P4 完成后）')
  record('G4', 'client 三包 · 四区呈现 · 管线卡片流', 'PASS', ['G4 已填充；G5 见下'])
}

function g5(): void {
  console.log('\nG5 单实例 launcher（锁 + ping + spawn + dev CLI）')
  const problems: string[] = []
  const launcherSrc = join(ROOT, 'packages/cicada/cicada-launcher/src')
  const launcherBin = join(ROOT, 'packages/cicada/cicada-launcher/bin')

  // G5.1: pure-function surface exists.
  const launcherText = existsSync(join(launcherSrc, 'launcher.ts')) ? readFileSync(join(launcherSrc, 'launcher.ts'), 'utf8') : ''
  for (const fn of ['acquireLock', 'ping', 'resolvePort', 'spawnHost', 'initProfile']) {
    if (!launcherText.includes(`export async function ${fn}`) && !launcherText.includes(`export function ${fn}`)) {
      problems.push(`launcher.ts missing ${fn}`)
    }
  }
  // G5.2: the ping endpoint registration lives in the host half (exact route, inject webServer).
  const indexText = existsSync(join(launcherSrc, 'index.ts')) ? readFileSync(join(launcherSrc, 'index.ts'), 'utf8') : ''
  for (const token of ["inject = ['webServer']", "kind: 'exact'", 'PING_PATH', "pid: process.pid"]) {
    if (!indexText.includes(token)) problems.push(`launcher index.ts missing ${token}`)
  }
  const launcherTextForPath = existsSync(join(launcherSrc, 'launcher.ts')) ? readFileSync(join(launcherSrc, 'launcher.ts'), 'utf8') : ''
  if (!launcherTextForPath.includes("PING_PATH = '/_cicada/ping'")) problems.push('launcher.ts missing PING_PATH constant')
  // G5.3: dev CLI bin exists + package.json bin/script registration.
  const launcherPkg = existsSync(join(ROOT, 'packages/cicada/cicada-launcher/package.json')) ? readFileSync(join(ROOT, 'packages/cicada/cicada-launcher/package.json'), 'utf8') : ''
  if (!existsSync(join(launcherBin, 'cicada.ts'))) problems.push('missing bin/cicada.ts')
  if (!launcherPkg.includes('"bin"') || !launcherPkg.includes('"cicada"')) problems.push('launcher package.json missing bin field')
  // G5.4: bundle registration (patch row + dependency) — the endpoint never
  // reaches the composition tree without it.
  const patchPath = join(ROOT, 'packages/bundle/cicada-app/cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (!patch.includes('@deepseek-ai/dsh-cicada-launcher')) problems.push('bundle patch missing cicada-launcher row')
  const bundleJson = existsSync(join(ROOT, 'packages/bundle/cicada-app/package.json')) ? readFileSync(join(ROOT, 'packages/bundle/cicada-app/package.json'), 'utf8') : ''
  if (!bundleJson.includes('@deepseek-ai/dsh-cicada-launcher')) problems.push('bundle package.json missing cicada-launcher dependency')
  // G5.5: the root `cicada` dev script exists (mirrors `dsh`).
  const rootPkg = existsSync(join(ROOT, 'package.json')) ? readFileSync(join(ROOT, 'package.json'), 'utf8') : ''
  if (!rootPkg.includes('"cicada"')) problems.push('root package.json missing cicada script')

  const pass = problems.filter((p) => !p.startsWith('ok:'))
  const details = pass.length === 0
    ? ['静态面齐备（锁/ping/端点/bin/登记/script）；动态判据已实测通过（P5 动态段：隔离 boot → ping {ok:true,pid} → 二启"已有实例"退出 0 → 仅一进程）——详见施工日志 P5 动态判据实测段']
    : pass
  record('G5.1', 'launcher 纯函数 + ping 端点 + dev CLI + bundle 登记 + 根 script', pass.length === 0 ? 'PASS' : 'FAIL', details)
}

function g5Summary(): void {
  console.log('\nG5-G7 关口（P5 完成后）')
  record('G5-G7', 'launcher 完成态 · editor-bridge · e2e', 'SKIP', ['G5 已填充；G6-G7 按 9-impl §0.2 顺序施工'])
}

function g6(): void {
  console.log('\nG6 编辑器控制面（cicada-editor-bridge：命名路由 + WS + 一次性 token + selection 注入）')
  const problems: string[] = []
  const bridgeSrc = join(ROOT, 'packages/cicada/cicada-editor-bridge/src')

  // G6.1: 契约文件齐全（端点常量 + 7 帧判别联合 + selectionItem + 错误码表）。
  const contract = existsSync(join(bridgeSrc, 'contract.ts')) ? readFileSync(join(bridgeSrc, 'contract.ts'), 'utf8') : ''
  for (const token of [
    "EDITOR_PATH_PREFIX = '/cicada/editor'",
    "SELECTION_PATH = '/cicada/editor/selection'",
    "STATE_PATH = '/cicada/editor/state'",
    "WS_PATH = '/cicada/editor/ws'",
    'SelectionKind',
    'EditorDownlink',
    'EDITOR_HTTP',
  ]) {
    if (!contract.includes(token)) problems.push(`contract.ts missing ${token}`)
  }
  // G6.2: 路由 handler = 两段鉴权（403 先于 401）+ 426/404 分发 + prefix 常量引用。
  const routes = existsSync(join(bridgeSrc, 'routes.ts')) ? readFileSync(join(bridgeSrc, 'routes.ts'), 'utf8') : ''
  for (const token of ['isTrustedApiRequest', 'UPGRADE_REQUIRED', 'extractBearer', 'createEditorRouteHandler', 'SELECTION_PATH']) {
    if (!routes.includes(token)) problems.push(`routes.ts missing ${token}`)
  }
  // G6.3: WS = exact upgrade 路由 + 101 前鉴权 + 帧校验（createWsBridge 在 ws.ts；registerUpgrade 在 index.ts）。
  const ws = existsSync(join(bridgeSrc, 'ws.ts')) ? readFileSync(join(bridgeSrc, 'ws.ts'), 'utf8') : ''
  for (const token of ['createWsBridge', 'path: WS_PATH', 'handleUpgrade', 'exactKeys', '1008']) {
    if (!ws.includes(token)) problems.push(`ws.ts missing ${token}`)
  }
  // G6.4: token = randomBytes(32) + timingSafeEqual + stdout 行。
  const tokenFile = existsSync(join(bridgeSrc, 'token.ts')) ? readFileSync(join(bridgeSrc, 'token.ts'), 'utf8') : ''
  for (const token of ['randomBytes(TOKEN_BYTES)', 'timingSafeEqual', 'cicada-editor:']) {
    if (!tokenFile.includes(token)) problems.push(`token.ts missing ${token}`)
  }
  // G6.5: 装配 = inject 服务 + prefix 注册 + upgrade 注册 + Events 合并 + followup 注入动作。
  const index = existsSync(join(bridgeSrc, 'index.ts')) ? readFileSync(join(bridgeSrc, 'index.ts'), 'utf8') : ''
  for (const token of ["inject = ['webServer', 'fs', 'agents']", "kind: 'prefix'", 'registerUpgrade', 'followup', 'createUserMessage', "ctx.emit('cicada/editor/selection'"]) {
    if (!index.includes(token)) problems.push(`index.ts missing ${token}`)
  }
  const types = existsSync(join(bridgeSrc, 'types.ts')) ? readFileSync(join(bridgeSrc, 'types.ts'), 'utf8') : ''
  if (!types.includes("'cicada/editor/selection'") || !types.includes('declare module')) problems.push('types.ts missing Events merge')
  // G6.6: Remote 白名单三处 + 双侧 tsconfig（satisfies 断言闭环）。
  const remoteEvents = existsSync(join(ROOT, 'packages/api/remotes/src/remote-events.ts')) ? readFileSync(join(ROOT, 'packages/api/remotes/src/remote-events.ts'), 'utf8') : ''
  if (!remoteEvents.includes("'cicada/editor/selection'") || !remoteEvents.includes("mode: 'emit'")) {
    problems.push('remote-events.ts missing whitelist entry')
  }
  for (const face of ['index.ts', 'client/index.ts']) {
    const file = existsSync(join(ROOT, 'packages/api/remotes/src', face)) ? readFileSync(join(ROOT, 'packages/api/remotes/src', face), 'utf8') : ''
    if (!file.includes('@deepseek-ai/dsh-cicada-editor-bridge/types')) problems.push(`remotes ${face} missing import type`)
  }
  // G6.7: bundle 登记（patch 行 + 依赖 + tsconfig.host 引用）。
  const patch = existsSync(join(ROOT, 'packages/bundle/cicada-app/cordis.patch.yml')) ? readFileSync(join(ROOT, 'packages/bundle/cicada-app/cordis.patch.yml'), 'utf8') : ''
  if (!patch.includes('@deepseek-ai/dsh-cicada-editor-bridge')) problems.push('bundle patch missing cicada-editor-bridge row')
  const bundleJson = existsSync(join(ROOT, 'packages/bundle/cicada-app/package.json')) ? readFileSync(join(ROOT, 'packages/bundle/cicada-app/package.json'), 'utf8') : ''
  if (!bundleJson.includes('@deepseek-ai/dsh-cicada-editor-bridge')) problems.push('bundle package.json missing cicada-editor-bridge dependency')
  const hostTsconfig = existsSync(join(ROOT, 'tsconfig.host.json')) ? readFileSync(join(ROOT, 'tsconfig.host.json'), 'utf8') : ''
  if (!hostTsconfig.includes('cicada-editor-bridge')) problems.push('tsconfig.host.json missing bridge reference')

  const pass = problems.filter((p) => !p.startsWith('ok:'))
  const details = pass.length === 0
    ? ['静态面齐备（契约/路由/WS/token/注入/白名单/登记）；动态判据已实测通过（隔离 boot：无 token 401 / 伪造 Host 403 / 错 token 401 / state 200 / ws GET 426 / 无会话 500 / 建会话后 POST 200 {injected:true} / 会话日志出现 plugin-source user/message）——详见施工日志 P6 动态段']
    : pass
  record('G6.1', 'editor-bridge 契约 + 路由/WS/token/注入 + Remote 白名单 + bundle 登记', pass.length === 0 ? 'PASS' : 'FAIL', details)
}

function g6Summary(): void {
  console.log('\nG6-G7 关口（P6 完成后）')
  record('G6-G7', 'editor-bridge 完成态 · e2e', 'SKIP', ['G6.1 已填充；G7 e2e 按 9-impl §0.2 顺序施工'])
}

function g7(): void {
  console.log('\nG7 最小端到端（基线 / user_edit 一次性提醒 / editor 下行帧）')
  const problems: string[] = []
  const runtime = join(ROOT, 'packages/cicada/cicada-runtime/src')
  const bridge = join(ROOT, 'packages/cicada/cicada-editor-bridge/src')
  const turn = existsSync(join(runtime, 'turn.ts')) ? readFileSync(join(runtime, 'turn.ts'), 'utf8') : ''
  const changelog = existsSync(join(runtime, 'changelog.ts')) ? readFileSync(join(runtime, 'changelog.ts'), 'utf8') : ''
  const index = existsSync(join(runtime, 'index.ts')) ? readFileSync(join(runtime, 'index.ts'), 'utf8') : ''
  const bridgeIndex = existsSync(join(bridge, 'index.ts')) ? readFileSync(join(bridge, 'index.ts'), 'utf8') : ''
  for (const token of ['reconcileWorkspace', 'baselineVersion', 'user_edit', 'watchWorkspace', 'agent/pre-step']) {
    if (!turn.includes(token) && !changelog.includes(token) && !index.includes(token)) problems.push(`runtime P7 missing ${token}`)
  }
  for (const token of ['publishRuntimeChange', "type: 'canvas.refresh'", "type: 'baseline'", "type: 'changelog'"]) {
    if (!bridgeIndex.includes(token)) problems.push(`editor bridge P7 missing ${token}`)
  }
  const test = join(ROOT, 'packages/cicada/cicada-runtime/tests/turn.spec.ts')
  const testText = existsSync(test) ? readFileSync(test, 'utf8') : ''
  for (const token of ['detects an external edit once', 'advances a baseline']) {
    if (!testText.includes(token)) problems.push(`P7 regression test missing: ${token}`)
  }
  // G7.2: execute the acceptance-level three-dialogue producer loop. The
  // adapter is scripted, but AgentLoop, producer, runtime, LocalFileSystem,
  // format and deriver are real; this is the executable M1-5 evidence.
  const e2eTest = join(ROOT, 'packages/cicada/cicada-runtime/tests/producer-loop.spec.ts')
  const e2eText = existsSync(e2eTest) ? readFileSync(e2eTest, 'utf8') : ''
  if (!e2eText.includes('P7/G7 end-to-end edit handoff')) problems.push('P7 acceptance test missing: edit handoff')
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitest)) {
    problems.push('vitest binary missing (pnpm install required)')
  } else {
    const run = spawnSync(process.execPath, [vitest, 'run', 'packages/cicada/cicada-runtime/tests/producer-loop.spec.ts', '--reporter=dot', '--maxWorkers=1'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000, shell: false,
    })
    if (run.status !== 0) problems.push(`P7 acceptance test failed (exit ${String(run.status)}); see output above`)
    else problems.push('ok: P7/G7 three-dialogue edit handoff acceptance passed')
  }
  const failures = problems.filter((p) => !p.startsWith('ok:'))
  record('G7.1', 'runtime 基线检测 + 一次性 user_edit + bridge 三类 WS 帧', failures.length === 0 ? 'PASS' : 'FAIL', failures.length === 0
    ? problems.filter((p) => p.startsWith('ok:'))
    : failures)
}

function g7Summary(): void {
  console.log('\nG7 关口（P7 完成后）')
  const gate = results.find(result => result.id === 'G7.1')
  const status = gate?.status === 'PASS' ? 'PASS' : 'FAIL'
  record('G7', '对话→工具→文件→回读→手改→一次性提醒', status, status === 'PASS'
    ? ['G7.1 runtime/bridge 闭环 + 隔离临时 workspace 三轮 AgentLoop 验收均通过；外部模型网络未纳入本项']
    : ['G7.1 未通过，拒绝把 G7 汇总标为 PASS'])
}

g0()
g1Golden()
g1Oracle()
g2()
g3()
g3Summary()
g4()
g4Summary()
g5()
g5Summary()
g6()
g6Summary()
g7()
g7Summary()

const failed = results.filter((r) => r.status === 'FAIL')
console.log(`\n═══ verify:cicada 汇总: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed.length} FAIL / ${results.filter((r) => r.status === 'SKIP').length} SKIP`)
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.id).join(', ')}`)
  process.exit(1)
}
