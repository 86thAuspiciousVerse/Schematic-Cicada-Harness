/**
 * Anchor audit (docs/05 §8): deterministic structural checks that must pass
 * before an entry may be published into the global database. Violations are
 * field-level and repair-driven (the datasheet agent fixes exactly what is
 * named and republishes), never silent.
 *
 * Rules that exist because a downstream consumer would otherwise fail late:
 * - a physical pin number belongs to exactly ONE group (the runtime pin
 *   universe rejects cross-group duplicates),
 * - the pin universe must be contiguous and start at 1 (same check),
 * - every group that carries pins carries at least one source claim and the
 *   pins only reference claims of that group (provenance, no invented pins),
 * - the shape block must cover exactly the pin universe (it is the symbol's
 *   only geometry input).
 */

import { ENGINE_SIDES } from '@deepseek-ai/dsh-cicada-symbols'

import type { DatasheetEntry } from './database.ts'

export interface AuditViolation {
  field: string
  message: string
}

export interface AuditResult {
  ok: boolean
  violations: AuditViolation[]
}

/** Deterministic structural audit (v2 hybrid artifacts). */
/**
 * @param entry - the complete artifact set to check.
 * @param expectedPart - the part number the caller asked for; defaults to the
 *   index's own `part_number` (the workspace audit passes the requested name,
 *   because a wrong index cannot vouch for its own identity).
 */
/** Whitespace-collapsed form used by the anchor checks (MinerU emits whole tables as one line). */
const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim()

export function runAudit(entry: DatasheetEntry, expectedPart?: string): AuditResult {
  const violations: AuditViolation[] = []
  const push = (field: string, message: string): void => {
    violations.push({ field, message })
  }
  if (entry.fullMd.trim() === '') push('full.md', 'full.md is empty')
  if (String(entry.index.part_number ?? '').trim() === '') push('index.part_number', 'part_number is empty')
  const groups = entry.index.groups ?? []
  if (!Array.isArray(groups) || groups.length === 0) {
    push('index.groups', 'no groups extracted')
    return { ok: false, violations }
  }

  const owner = new Map<string, string>()
  const numbers: number[] = []
  let pinCount = 0
  for (const group of groups) {
    const at = `index.groups[${group.group_id || '?'}]`
    if (String(group.group_id ?? '').trim() === '') push('index.groups[].group_id', 'group_id is empty')
    if (String(group.title ?? '').trim() === '') push(`${at}.title`, 'title is empty')
    const claims = group.source_claims ?? []
    const claimIds = new Set<string>()
    for (const claim of claims) {
      if (String(claim.claim_id ?? '').trim() === '') push(`${at}.source_claims`, 'claim_id is empty')
      else claimIds.add(claim.claim_id)
      if (String(claim.source_ref ?? '').trim() === '') push(`${at}.source_claims[${claim.claim_id}]`, 'source_ref is empty')
      if (String(claim.extracted_fact ?? '').trim() === '') push(`${at}.source_claims[${claim.claim_id}]`, 'extracted_fact is empty')
    }
    const pins = group.pins ?? []
    for (const pin of pins) {
      const number = String(pin.physical_number ?? '')
      if (number.trim() === '') {
        push(`${at}.pins`, 'physical_number is empty')
        continue
      }
      const previous = owner.get(number)
      if (previous !== undefined) {
        push(`${at}.pins`, `physical_number ${number} is already owned by group ${previous} (a pin belongs to exactly one group)`)
      } else {
        owner.set(number, group.group_id)
      }
      for (const claimId of pin.source_claim_ids ?? []) {
        if (!claimIds.has(claimId)) push(`${at}.pins[${number}]`, `source_claim_id ${claimId} is not defined in this group`)
      }
      pinCount += 1
      const parsed = Number.parseInt(number, 10)
      if (Number.isFinite(parsed)) numbers.push(parsed)
      else push(`${at}.pins`, `physical_number ${number} is not numeric`)
    }
    if (pins.length === 0) continue
    if (claims.length === 0) push(`${at}.source_claims`, 'a group that carries pins needs at least one source claim')
    // v3（2026-09-13）：组必须自述"这组里有什么"——producer 靠它决定展开哪一组。
    const description = String(group.description ?? '').trim()
    if (description.length < 24) {
      push(`${at}.description`, description === ''
        ? 'group description is missing (say what the group holds, its source table/section, and when it is needed)'
        : `group description is too short to be useful (${String(description.length)} chars)`)
    }
    const detail = entry.detail[group.group_id]
    if (detail === undefined) {
      push(`detail[${group.group_id}]`, 'detail file missing for group')
      continue
    }
    if (detail.group_id !== group.group_id) push(`detail[${group.group_id}].group_id`, `detail group_id is ${detail.group_id}`)
    const detailNumbers = new Set((detail.pins ?? []).map((pin) => String(pin.physical_number)))
    const indexNumbers = new Set(pins.map((pin) => String(pin.physical_number)))
    for (const number of indexNumbers) if (!detailNumbers.has(number)) push(`detail[${group.group_id}].pins`, `pin ${number} is in the index but not in the detail`)
    for (const number of detailNumbers) if (!indexNumbers.has(number)) push(`detail[${group.group_id}].pins`, `pin ${number} is in the detail but not in the index`)
  }

  // v3 契约开关（2026-09-13）：`schema_version: "3"` 起，锚点必须真的定位得住——
  // 老的 v2/0.3 产物不受此约束（存量容忍），新产物一律走这里。
  const version = String(entry.index.schema_version ?? '')
  if (version === '3' || Number.parseInt(version, 10) >= 3) {
    const lines = entry.fullMd.split(/\r?\n/)
    for (const group of entry.index.groups) {
      const at = `groups[${group.group_id}]`
      const location = group.location
      const start = location?.line_start
      const end = location?.line_end
      if (typeof start !== 'number' || typeof end !== 'number' || start < 1 || end < start || end > Math.max(lines.length, 1)) {
        push(`${at}.location`, 'v3 groups must declare location{line_start,line_end,search_signature} inside the source')
        continue
      }
      const span = collapse(lines.slice(start - 1, end).join('\n'))
      for (const claim of group.source_claims ?? []) {
        const excerpt = String(claim.verbatim_excerpt ?? '').trim()
        const fact = String(claim.extracted_fact ?? '').trim()
        if (excerpt === '') {
          push(`${at}.source_claims[${claim.claim_id}].verbatim_excerpt`, 'v3 claims must quote the source verbatim')
          continue
        }
        if (!span.includes(collapse(excerpt))) {
          push(`${at}.source_claims[${claim.claim_id}].verbatim_excerpt`, 'verbatim_excerpt does not occur inside the declared location range')
        }
        if (fact === '' || !collapse(excerpt).includes(collapse(fact))) {
          push(`${at}.source_claims[${claim.claim_id}].extracted_fact`, 'extracted_fact must be a verbatim substring of verbatim_excerpt')
        }
      }
    }
  }

  if (pinCount === 0) {
    push('pin universe', 'no pins across groups')
  } else {
    const sorted = [...new Set(numbers)].sort((left, right) => left - right)
    const first = sorted[0]
    if (first !== undefined && first !== 1) push('pin universe', `physical numbering must start at 1 (starts at ${first})`)
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] !== (sorted[index - 1] ?? 0) + 1) {
        push('pin universe', `physical numbering has a gap at ${String(sorted[index])}`)
        break
      }
    }
  }

  if (entry.shape === undefined) {
    push('shape.json', 'shape block missing (the datasheet lane owes one)')
  } else {
    // The engine keys the synthesized user-library symbol by this name (the
    // runtime overrides it with the requested part), so a block naming a
    // DIFFERENT part would shadow that part's entry — measured 2026-09-13:
    // datasheet/AMS1117-3.3/shape.json carried `name: "AMS1117"` and the engine
    // minted IC:AMS1117 instead of IC:AMS1117-3.3.
    const blockName = String(entry.shape.name ?? '').trim()
    const identity = String(expectedPart ?? entry.index.part_number ?? '').trim()
    if (identity !== '' && blockName !== identity) {
      push('shape.json.name', `shape block name "${blockName}" must equal the part number "${identity}"`)
    }
    const shapePins = entry.shape.pins ?? []
    if (shapePins.length === 0) push('shape.json', 'shape block has no pins')
    const shapeNumbers = new Set(shapePins.map((pin) => String(pin.number)))
    for (const number of owner.keys()) if (!shapeNumbers.has(number)) push('shape.json', `pin ${number} is missing from the shape block`)
    for (const number of shapeNumbers) if (!owner.has(number)) push('shape.json', `shape pin ${number} is not in the datasheet pin universe`)
    for (const pin of shapePins) {
      if (String(pin.name ?? '').trim() === '') push(`shape.json[${String(pin.number)}].name`, 'shape pin has no name')
      if (String(pin.electrical ?? '').trim() === '') push(`shape.json[${String(pin.number)}].electrical`, 'shape pin has no electrical type')
      // The engine only accepts the four canonical sides; a symbol authored with
      // `L/B/R/T` (measured 2026-09-13, 48-pin LQFP) is refused by
      // /lib/synthesize, so say it here — while the datasheet agent can still fix it.
      const side = pin.side
      if (side !== undefined && String(side).trim() !== ''
        && !(ENGINE_SIDES as readonly string[]).includes(String(side).trim().toLowerCase())) {
        push(`shape.json[${String(pin.number)}].side`, `side "${String(side)}" is not one of ${ENGINE_SIDES.join('/')}`)
      }
    }
  }
  return { ok: violations.length === 0, violations }
}
