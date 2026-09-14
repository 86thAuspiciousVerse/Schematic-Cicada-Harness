import { describe, expect, it } from 'vitest'

import { validateDesignIntent, type DesignIntent } from '../src/intent.ts'

/** Trimmed copy of the v0.3 landscape an STM32 minimum-system request produced. */
const landscape = (): DesignIntent => ({
  schema_version: '0.3',
  request_id: 'accept-001',
  selected_parts: {
    parts: [
      { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', package: 'LQFP48', role: '主控制器（最小系统核心）', binding_strength: 'user_required', datasheet_required: true },
      { part_ref: 'part_ams1117', part_number: 'AMS1117-3.3', package: 'SOT-223', role: '5V 转 3.3V 电源稳压', binding_strength: 'user_required', datasheet_required: true },
      { part_ref: 'part_hse_crystal', part_number: '8MHz-Crystal', selection_state: 'conditional', binding_strength: 'inferred_candidate', datasheet_required: false },
      { part_ref: 'part_usb_connector', part_number: 'USB-Connector', selection_state: 'conditional', datasheet_required: false },
    ],
  },
  datasheet_requests: [
    { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', package: 'LQFP48', reason: '引脚定义与电气信息' },
    { part_ref: 'part_ams1117', part_number: 'AMS1117-3.3', package: 'SOT-223', reason: '引脚定义与电容要求' },
  ],
})

describe('design_intent datasheet boundary', () => {
  it('extracts the requested datasheets from a v0.3 landscape', () => {
    expect(validateDesignIntent(landscape())).toEqual({ ok: true, datasheetRequired: ['STM32F103C8T6', 'AMS1117-3.3'] })
  })

  it('accepts a landscape with no datasheet needs', () => {
    const intent = landscape()
    intent.datasheet_requests = []
    expect(validateDesignIntent(intent)).toEqual({ ok: true, datasheetRequired: [] })
  })

  it('requires selected_parts.parts and datasheet_requests to be present', () => {
    expect(validateDesignIntent({})).toEqual({ ok: false, violations: ['selected_parts.parts is missing or empty'] })
    const noRequests = landscape()
    delete noRequests.datasheet_requests
    const result = validateDesignIntent(noRequests)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.violations.join()).toContain('datasheet_requests is missing')
  })

  it('rejects a request that is not a selected part', () => {
    const intent = landscape()
    intent.datasheet_requests = [{ part_ref: 'part_lm358', part_number: 'LM358', reason: '运放' }]
    const result = validateDesignIntent(intent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.violations[0]).toContain('LM358')
  })

  it('rejects a request that contradicts selected_parts and duplicate keys', () => {
    const crystal = landscape()
    crystal.datasheet_requests = [{ part_ref: 'part_hse_crystal', part_number: '8MHz-Crystal', reason: '晶振' }]
    const contradicted = validateDesignIntent(crystal)
    expect(contradicted.ok).toBe(false)
    if (!contradicted.ok) expect(contradicted.violations[0]).toContain('datasheet_required: false')

    const duplicate = landscape()
    duplicate.datasheet_requests = [
      { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', reason: 'a' },
      { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', reason: 'b' },
    ]
    const duped = validateDesignIntent(duplicate)
    expect(duped.ok).toBe(false)
    if (!duped.ok) expect(duped.violations[0]).toContain('duplicate datasheet request')
  })

  it('rejects generic labels and missing part refs', () => {
    const generic = landscape()
    generic.selected_parts = { parts: [{ part_ref: 'part_mcu', part_number: 'stm32', datasheet_required: true }] }
    generic.datasheet_requests = [{ part_ref: 'part_mcu', part_number: 'stm32', reason: 'generic' }]
    const result = validateDesignIntent(generic)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.violations.join()).toContain('looks like a generic label')

    const noRef = landscape()
    noRef.selected_parts = { parts: [{ part_ref: '', part_number: 'STM32F103C8T6', datasheet_required: true }] }
    noRef.datasheet_requests = []
    const refResult = validateDesignIntent(noRef)
    expect(refResult.ok).toBe(false)
    if (!refResult.ok) expect(refResult.violations[0]).toContain('without part_ref')
  })
})

describe('v0.4 landscape contract (three old disciplines + structured parameters)', () => {
  const landscape = (extra: Record<string, unknown> = {}) => ({
    schema_version: '0.4',
    selected_parts: { parts: [{ part_ref: 'part_stm32', part_number: 'STM32F103C8T6', component_kind: 'microcontroller', datasheet_required: true }] },
    datasheet_requests: [{ part_ref: 'part_stm32', part_number: 'STM32F103C8T6' }],
    ...extra,
  })

  it('accepts a clean v0.4 landscape', () => {
    expect(validateDesignIntent(landscape({
      functional_blocks: [{ name: 'power', parameters: [{ name: 'vdd_local', value: '100nF', binding_strength: 'user_required', source_kind: 'engineering_practice' }] }],
      evidence: [{ id: 'EV-01', source_kind: 'web_search', source_ref: 'https://example.invalid/ds.pdf', claim: 'decouple every VDD pin' }],
    }))).toEqual({ ok: true, datasheetRequired: ['STM32F103C8T6'] })
  })

  it('rejects passives, pin-level text, datasheet_text evidence and string parameters', () => {
    const result = validateDesignIntent(landscape({
      selected_parts: {
        parts: [
          { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', component_kind: 'microcontroller', datasheet_required: true },
          { part_ref: 'part_cap', part_number: 'GRM155R71C104KA88', component_kind: 'capacitor_ceramic' },
        ],
      },
      functional_blocks: [{ name: 'power', parameters: ['100nF per VDD pin'] }],
      evidence: [{ id: 'EV-01', source_kind: 'datasheet_text', claim: 'VDD range' }],
      features: [{ name: 'reset', note: 'connect pin 7 to the NRST net' }],
    }))
    expect(result.ok).toBe(false)
    const joined = (result as { violations: string[] }).violations.join('\n')
    expect(joined).toContain('generic passive')
    expect(joined).toContain('structured parameters')
    expect(joined).toContain('datasheet_text')
    expect(joined).toContain('pin-level detail')
  })

  it('rejects unknown fields and out-of-whitelist enums', () => {
    const result = validateDesignIntent(landscape({
      owner: 'someone',
      selected_parts: { parts: [
        { part_ref: 'part_stm32', part_number: 'STM32F103C8T6', component_kind: 'mcu', datasheet_required: true, selection_state: 'maybe', binding_strength: 'engineer_recommended' },
      ] },
      functional_blocks: [{ name: 'power', parameters: [{ name: 'vdd', value: '100nF', binding_strength: 'user_required', source_kind: 'datasheet' }] }],
      evidence: [{ id: 'EV-01', source_kind: 'datasheet_text', claim: 'x' }],
    }))
    expect(result.ok).toBe(false)
    const joined = (result as { violations: string[] }).violations.join('\n')
    expect(joined).toContain('unknown top-level field "owner"')
    expect(joined).toContain('selection_state "maybe"')
    expect(joined).toContain('binding_strength "engineer_recommended"')
    expect(joined).toContain('source_kind "datasheet"')
    expect(joined).toContain('source_kind "datasheet_text"')
  })

  it('leaves v0.3 landscapes on the old rules', () => {
    const legacy = {
      ...landscape({
        functional_blocks: [{ name: 'power', parameters: ['100nF per VDD pin'] }],
        evidence: [{ id: 'EV-01', source_kind: 'datasheet_text', claim: 'VDD range' }],
      }),
      schema_version: '0.3',
    }
    expect(validateDesignIntent(legacy).ok).toBe(true)
  })
})
