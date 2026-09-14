/**
 * The knowledge landscape (`design_intent.json`) contract.
 *
 * Shape follows the v0.3 landscape the earlier pipeline produced (reference
 * instance: `schematic-cicada-dsh-context/.schematic/accept-001/design_intent.json`,
 * an STM32F103C8T6 minimum-system board): `selected_parts.parts[]` carries every
 * candidate part with its role/binding strength, and `datasheet_requests[]`
 * names the subset that needs the datasheet artifact set (index / detail /
 * shape), keyed by the exact part number.
 *
 * The validator is the gate between "the knowledge agent wrote a landscape" and
 * "the datasheet lane may start": it never decides part selection itself.
 */

/** One part in the landscape. Extra producer fields are preserved. */
export interface DesignIntentPart {
  /** Stable reference used by blocks/features/requests (`part_stm32`). */
  part_ref: string
  /** Exact part number — the datasheet key and the workspace folder name. */
  part_number: string
  package?: string | null
  component_kind?: string
  role?: string
  selection_state?: string
  binding_strength?: string
  source_kind?: string
  datasheet_required?: boolean
  condition_text?: string | null
  [key: string]: unknown
}

/** v0.4 允许的枚举（老契约 `contracts/base.py`/`design_intent.py` 的 Literal + 新道在用的
 * `engineering_recommended`）；白名单而非黑名单，拼写漂移与"偷偷读数据手册"都会被拦下。 */
const V04_BINDING_STRENGTH = new Set([
  'user_required', 'user_preferred', 'inferred_required', 'inferred_candidate', 'example_only',
  'engineering_recommended',
])
/** knowledge 阶段能有的来源：读数据手册是 datasheet 道的活，不在此列。 */
const V04_SOURCE_KINDS = new Set(['user_request', 'web_search', 'engineering_practice', 'llm_inference'])
const V04_SELECTION_STATES = new Set(['required', 'suggested', 'alternative', 'conditional'])
/** v0.4 的字段白名单（老契约 `extra="forbid"` 语义）。 */
const V04_TOP_KEYS = new Set([
  'schema_version', 'request_id', 'user_request_summary', 'requirement_decomposition', 'functional_blocks',
  'features', 'selected_parts', 'datasheet_requests', 'evidence', 'open_questions',
])
const V04_PART_KEYS = new Set([
  'part_ref', 'part_number', 'package', 'component_kind', 'role', 'selection_state', 'binding_strength',
  'source_kind', 'datasheet_required', 'condition_text',
])
const V04_PARAMETER_KEYS = new Set(['name', 'value', 'binding_strength', 'source_kind'])

/** Every string inside the landscape, with its path (for the pin-level-detail check). */
function landscapeStrings(value: unknown, path = 'design_intent'): [string, string][] {
  if (typeof value === 'string') return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((item, index) => landscapeStrings(item, `${path}[${String(index)}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => landscapeStrings(item, `${path}.${key}`))
  }
  return []
}

/** One datasheet the main agent must have before the producer can draw the part. */
export interface DatasheetRequest {
  part_ref: string
  part_number: string
  package?: string | null
  reason?: string
  [key: string]: unknown
}

/** The knowledge landscape. */
export interface DesignIntent {
  schema_version?: string
  request_id?: string
  selected_parts?: { parts?: DesignIntentPart[] }
  datasheet_requests?: DatasheetRequest[]
  [key: string]: unknown
}

/** Exact-part-number shape shared by both lists (also the workspace folder name). */
function exactName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/\s/.test(value.trim())
}

/**
 * Validate the knowledge landscape and extract the datasheet lane.
 * @param intent - parsed `design_intent.json`.
 * @returns the unique requested part numbers, or the violations that block the
 *   lane. A request must name a selected part marked `datasheet_required`, and
 *   one part number may appear at most once (the library key is unique).
 */
export function validateDesignIntent(intent: DesignIntent): { ok: true; datasheetRequired: string[] } | { ok: false; violations: string[] } {
  const violations: string[] = []
  const parts = intent.selected_parts?.parts
  if (!Array.isArray(parts) || parts.length === 0) {
    return { ok: false, violations: ['selected_parts.parts is missing or empty'] }
  }
  const byRef = new Map<string, DesignIntentPart>()
  const byNumber = new Map<string, DesignIntentPart>()
  for (const part of parts) {
    if (!exactName(part?.part_number)) violations.push(`selected part without an exact part_number: ${String(part?.part_ref ?? '?')}`)
    if (typeof part?.part_ref !== 'string' || part.part_ref === '') violations.push(`selected part without part_ref: ${String(part?.part_number ?? '?')}`)
    if (typeof part?.part_ref === 'string' && part.part_ref !== '') byRef.set(part.part_ref, part)
    if (exactName(part?.part_number)) byNumber.set(part.part_number, part)
  }
  // v0.4 契约开关（2026-09-13）：老三条纪律 + 结构化 parameters 只在 v0.4 起强制，
  // v0.3 存量图景继续按老规则放行（在盘的五份图景呈四种形状，正是要收的地方）。
  const loose = intent as unknown as Record<string, unknown>
  const version = String(loose.schema_version ?? '')
  if (version === '0.4' || Number.parseFloat(version) >= 0.4) {
    // ① 通用无源件不进 selected_parts：它们的"设计方向"属于 parameters（老 SKILL.md:134）。
    const GENERIC_PASSIVE = /capacitor|resistor|inductor|crystal|ferrite/i
    for (const part of parts) {
      const kind = String(part?.component_kind ?? '')
      if (GENERIC_PASSIVE.test(kind) && part?.datasheet_required !== true) {
        violations.push(`selected part ${String(part?.part_number ?? '?')} is a generic passive (${kind}): passives stay out of selected_parts; their design direction belongs in functional_blocks[].parameters`)
      }
    }
    // ② 图景只写意图，不写引脚号/引脚级连线（那是 datasheet 道的事）。
    const PIN_OR_TOPO = /\bpin[ _-]?\d+\b|引脚\s*\d+|physical_number/i
    for (const [where, text] of landscapeStrings(loose)) {
      if (PIN_OR_TOPO.test(text)) {
        violations.push(`${where} carries pin-level detail ("${text.slice(0, 60)}"): the landscape names intent, not pin numbers or wiring`)
      }
    }
    // ③ 白名单：字段未知即拒（老 extra="forbid"）；来源只许 knowledge 阶段真能拿到的那些
    // （读数据手册是 datasheet 道的活，`datasheet`/`datasheet_text` 都在白名单之外）。
    for (const key of Object.keys(loose)) {
      if (!V04_TOP_KEYS.has(key)) violations.push(`unknown top-level field "${key}" (v0.4 forbids extras)`)
    }
    for (const part of parts) {
      for (const key of Object.keys(part)) {
        if (!V04_PART_KEYS.has(key)) violations.push(`selected part ${String(part.part_number ?? '?')} has an unknown field "${key}" (v0.4 forbids extras)`)
      }
      const state = part?.selection_state
      if (state !== undefined && !V04_SELECTION_STATES.has(String(state))) {
        violations.push(`selected part ${String(part.part_number ?? '?')} has selection_state "${String(state)}" (allowed: ${[...V04_SELECTION_STATES].join('/')})`)
      }
      const partBinding = part?.binding_strength
      if (partBinding !== undefined && !V04_BINDING_STRENGTH.has(String(partBinding))) {
        violations.push(`selected part ${String(part.part_number ?? '?')} has binding_strength "${String(partBinding)}" (allowed: ${[...V04_BINDING_STRENGTH].join('/')})`)
      }
      const partSource = part?.source_kind
      if (partSource !== undefined && !V04_SOURCE_KINDS.has(String(partSource))) {
        violations.push(`selected part ${String(part.part_number ?? '?')} has source_kind "${String(partSource)}" (the knowledge stage may use only: ${[...V04_SOURCE_KINDS].join('/')})`)
      }
    }
    for (const evidence of Array.isArray(loose.evidence) ? loose.evidence : []) {
      const item = evidence as Record<string, unknown>
      const kind = String(item?.source_kind ?? '')
      if (!V04_SOURCE_KINDS.has(kind)) {
        violations.push(`evidence ${String(item?.id ?? '?')} has source_kind "${kind}" (the knowledge stage may use only: ${[...V04_SOURCE_KINDS].join('/')}; reading the datasheet is the datasheet lane's job)`)
      }
    }
    // ④ parameters 结构化：{name, value, binding_strength, source_kind} 四字段必填。
    for (const [index, block] of (Array.isArray(loose.functional_blocks) ? loose.functional_blocks : []).entries()) {
      const parameters = (block as Record<string, unknown>)?.parameters
      if (parameters === undefined) continue
      if (!Array.isArray(parameters)) {
        violations.push(`functional_blocks[${String(index)}].parameters must be an array of {name,value,binding_strength,source_kind}`)
        continue
      }
      for (const parameter of parameters) {
        const item = parameter as Record<string, unknown>
        for (const field of ['name', 'value', 'binding_strength', 'source_kind']) {
          if (typeof item?.[field] !== 'string' || String(item[field]).trim() === '') {
            violations.push(`functional_blocks[${String(index)}].parameters[] is missing ${field} (v0.4 requires structured parameters)`)
          }
        }
        for (const key of Object.keys(item)) {
          if (!V04_PARAMETER_KEYS.has(key)) violations.push(`functional_blocks[${String(index)}].parameters[] has an unknown field "${key}" (v0.4 forbids extras)`)
        }
        const binding = String(item?.binding_strength ?? '')
        if (binding !== '' && !V04_BINDING_STRENGTH.has(binding)) {
          violations.push(`functional_blocks[${String(index)}].parameters[] has binding_strength "${binding}" (allowed: ${[...V04_BINDING_STRENGTH].join('/')})`)
        }
        const source = String(item?.source_kind ?? '')
        if (source !== '' && !V04_SOURCE_KINDS.has(source)) {
          violations.push(`functional_blocks[${String(index)}].parameters[] has source_kind "${source}" (the knowledge stage may use only: ${[...V04_SOURCE_KINDS].join('/')})`)
        }
      }
    }
  }

  const requests = intent.datasheet_requests
  if (requests === undefined) return { ok: false, violations: [...violations, 'datasheet_requests is missing (use [] when no part needs a datasheet)'] }
  if (!Array.isArray(requests)) return { ok: false, violations: [...violations, 'datasheet_requests is not an array'] }
  const datasheetRequired: string[] = []
  for (const request of requests) {
    const number = request?.part_number
    if (!exactName(number)) {
      violations.push(`datasheet request without an exact part_number (part_ref ${String(request?.part_ref ?? '?')})`)
      continue
    }
    // The datasheet key is the exact part number: a lowercase, digit-only-ish
    // label ("stm32") names no document and no library entry.
    if (!/[A-Z]/.test(number)) {
      violations.push(`datasheet request ${number} looks like a generic label; use the exact part number`)
      continue
    }
    const selected = byRef.get(String(request?.part_ref)) ?? byNumber.get(number)
    if (selected === undefined) {
      violations.push(`datasheet request ${number} is not a selected part`)
      continue
    }
    if (selected.datasheet_required === false) {
      violations.push(`datasheet request ${number} contradicts selected_parts (datasheet_required: false)`)
      continue
    }
    if (datasheetRequired.includes(number)) {
      violations.push(`duplicate datasheet request for ${number} (the library key is unique)`)
      continue
    }
    datasheetRequired.push(number)
  }
  return violations.length === 0 ? { ok: true, datasheetRequired } : { ok: false, violations }
}
