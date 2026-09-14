import { describe, expect, it } from 'vitest'

import { CicadaFormat } from '@deepseek-ai/dsh-cicada-format'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { CicadaError } from '../src/errors.ts'

function expectError(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CicadaError)
  expect((thrown as CicadaError).code).toBe(code)
}

import { Model } from '../src/file-model.ts'
import { bboxOf, nextPlacement } from '../src/layout.ts'
import {
  connectPins,
  datasheetShapeBlock,
  isDetailAnchor,
  toEngineBlock,
  disconnect,
  placeLabel,
  placeNoConnect,
  placePowerSymbol,
  placeSymbol,
  removeComponent,
  setProperty,
  type OpHost,
} from '../src/ops.ts'
import { emptySchematicText } from '../src/turn.ts'
import { cicadaWriteTools, type CicadaToolHost } from '../src/tools.ts'

const format = new CicadaFormat({} as never)

function emptyModel(): Model {
  return new Model(format.parse(emptySchematicText()))
}

const noHost: OpHost = { datasheet: () => undefined }

describe('place_symbol (8-spec §2)', () => {
  it('places a template symbol at the deterministic start slot', () => {
    const model = emptyModel()
    const result = placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2', footprint: '0805' }, noHost)
    expect(result.refdes).toBe('R1')
    expect(result.lib_id).toBe('cicada:R')
    const symbol = model.file.symbols[0]
    expect(symbol).toMatchObject({ libId: 'cicada:R', at: { x: 2540, y: 2540 }, rotation: 0, unit: 1 })
    expect(symbol.properties.Reference).toBe('R1')
    expect(symbol.properties.Value).toBe('10k')
    expect(symbol.properties.Footprint).toBe('0805')
    expect(symbol.pins.map((p) => p.number)).toEqual(['1', '2'])
    // Pin world coordinates: pin1 at (0, 3.81) file → world y = 2540 - 381 = 2159.
    expect(result.pin_table['1']).toMatchObject({ canonical_name: '1', x_mm: 25.4, y_mm: 21.59, electrical: 'passive' })
    expect(result.pin_table['2']).toMatchObject({ x_mm: 25.4, y_mm: 29.21 })
  })

  it('reuses the lib entry for a second symbol of the same lib', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placeSymbol(model, { refdes: 'R2', value: '4.7k', kind: 'sym2' }, noHost)
    expect(model.file.libSymbols.filter((s) => s.libId === 'cicada:R')).toHaveLength(1)
    expect(model.file.symbols).toHaveLength(2)
    expect(model.file.symbols[1].at).not.toEqual(model.file.symbols[0]?.at)
  })

  it('rejects a duplicate refdes', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    expectError(() => placeSymbol(model, { refdes: 'R1', value: '20k', kind: 'sym2' }, noHost), 'duplicate_refdes')
  })

  it('rejects an unknown template kind with symbol_unsupported', () => {
    expectError(() => placeSymbol(emptyModel(), { refdes: 'X1', value: 'x', kind: 'bogus' }, noHost), 'symbol_unsupported')
  })

  it('M1b library lane: places a multi-pin symbol from engine geometry', () => {
    const model = emptyModel()
    const host: OpHost = {
      datasheet: () => undefined,
      lib: {
        get: (name) => name === 'LED_RGB'
          ? {
              libId: 'LED:LED_RGB',
              name,
              pins: [
                { number: '1', name: 'R', x: -5080, y: 0, angle: 0 },
                { number: '2', name: 'G', x: 5080, y: 0, angle: 180 },
                { number: '3', name: 'B', x: 0, y: -5080, angle: 90 },
                { number: '4', name: 'A', x: 0, y: 5080, angle: 270 },
              ],
            }
          : undefined,
        list: () => ['LED_RGB'],
      },
    }
    const result = placeSymbol(model, { refdes: 'D1', value: 'RGB', lib_id: 'LED:LED_RGB' }, host)
    // 条目与实例都写引擎规范键（docs/09 §1），不再伪造 `cicada:` 前缀。
    expect(result.lib_id).toBe('LED:LED_RGB')
    expect(model.file.symbols[0]?.libId).toBe('LED:LED_RGB')
    expect(model.file.symbols[0]?.pins.map((p) => p.number)).toEqual(['1', '2', '3', '4'])
    const lib = model.libOf('LED:LED_RGB')
    expect(lib?.pins).toHaveLength(4)
    expect(lib?.pins[0]).toMatchObject({ number: '1', at: { x: -5080, y: 0 }, angle: 0 })
    // reuse: second placement does not duplicate the lib entry
    placeSymbol(model, { refdes: 'D2', value: 'RGB', lib_id: 'LED:LED_RGB' }, host)
    expect(model.file.libSymbols.filter((s) => s.libId === 'LED:LED_RGB')).toHaveLength(1)
  })

  it('M1b library lane: a name-only lib_id resolves to the engine canonical key', () => {
    const model = emptyModel()
    const host: OpHost = {
      datasheet: () => undefined,
      lib: {
        get: (name) => name === 'C_Small'
          ? { libId: 'C:C_Small', name, pins: [
            { number: '1', name: '', x: 0, y: 254, angle: 270 },
            { number: '2', name: '', x: 0, y: -254, angle: 90 },
          ] }
          : undefined,
        list: () => ['C_Small'],
      },
    }
    const result = placeSymbol(model, { refdes: 'C1', value: '100nF', lib_id: 'C_Small' }, host)
    expect(result.lib_id).toBe('C:C_Small')
    expect(model.libOf('C:C_Small')?.name).toBe('C_Small')
  })

  it('M1b library lane: unknown name lists available symbols (symbol_unsupported)', () => {
    const host: OpHost = {
      datasheet: () => undefined,
      lib: {
        get: () => undefined,
        list: () => ['R', 'C', 'LED_RGB'],
      },
    }
    expectError(() => placeSymbol(emptyModel(), { refdes: 'X1', value: 'x', lib_id: 'R:NOPE' }, host), 'symbol_unsupported')
  })

  it('M1b library lane: unavailable without an engine client falls back with explicit error', () => {
    expectError(() => placeSymbol(emptyModel(), { refdes: 'X1', value: 'x', lib_id: 'LED:LED_RGB' }, noHost), 'symbol_unsupported')
  })

  it('rejects a datasheet placement without knowledge (datasheet_missing)', () => {
    expectError(() => placeSymbol(emptyModel(), { refdes: 'U1', value: 'STM32C011J4M6', part_number: 'STM32C011J4M6', package: 'SO8', source_ids: ['detail/g1.json'] }, noHost), 'datasheet_missing')
  })

  it('places a datasheet IC when the pin universe is complete and rejects incomplete ones', () => {
    const host: OpHost = {
      datasheet: (part) => part === 'STM32C011J4M6'
        ? {
            part_number: part,
            expected: 4,
            groups: [
              [{ physicalNumber: '1', name: 'VDD', type: 'power_in' }],
              [{ physicalNumber: '2', name: 'PA0' }],
              [{ physicalNumber: '3', name: 'PA1' }],
              [{ physicalNumber: '4', name: 'GND', type: 'power_in' }],
            ],
          }
        : undefined,
    }
    const model = emptyModel()
    const result = placeSymbol(model, { refdes: 'U1', value: 'STM32C011J4M6', part_number: 'STM32C011J4M6', package: 'SO8', source_ids: ['detail/g1.json'] }, host)
    expect(result.lib_id).toBe('IC:STM32C011J4M6')
    const lib = model.libOf('IC:STM32C011J4M6')
    expect(lib?.pins).toHaveLength(4)
    expect(lib?.pins.map((p) => p.name)).toEqual(['VDD', 'PA0', 'PA1', 'GND'])
    expect(lib?.pins.map((p) => p.type)).toEqual(['power_in', 'passive', 'passive', 'power_in'])
    expect(result.pin_table['1']).toMatchObject({ canonical_name: 'VDD', electrical: 'power_in' })
    expect(model.file.symbols[0]?.properties.Datasheet).toBe('STM32C011J4M6')

    // Incomplete universe → pin_universe_incomplete, file untouched.
    const bad = emptyModel()
    const incomplete: OpHost = { datasheet: () => ({ part_number: 'X', expected: 8, groups: [[{ physicalNumber: '1' }], [{ physicalNumber: '2' }]] }) }
    expectError(() => placeSymbol(bad, { refdes: 'U9', value: 'X', part_number: 'X', package: '', source_ids: ['detail/g1.json'] }, incomplete), 'pin_universe_incomplete')
    expect(bad.file.symbols).toHaveLength(0)
    expect(bad.file.libSymbols).toHaveLength(0)
  })

  it('M1e-1 datasheetShapeBlock: 语义形状块（number/name/electrical；无任何几何字段）', () => {
    const block = datasheetShapeBlock('AMS1117', {
      part_number: 'AMS1117',
      expected: 3,
      groups: [[
        { physicalNumber: '1', name: 'GND', type: 'ground' },
        { physicalNumber: '2', name: 'VOUT', type: 'power' },
        { physicalNumber: '3', name: 'VIN', type: 'in' },
      ]],
    })
    expect(block.name).toBe('AMS1117')
    expect(block.refPrefix).toBe('U')
    expect(block.pins).toHaveLength(3)
    // ground→power_in、power→power_in（无方向信息，两者均电源参考）、信号 in→input
    expect(block.pins.map((p) => p.electrical)).toEqual(['power_in', 'power_in', 'input'])
    expect(Object.keys(block.pins[0] ?? {})).toEqual(['number', 'name', 'electrical'])
  })

  it('maps datasheet electrical directions to schematic pin types', () => {    const model = emptyModel()
    placeSymbol(model, {
      refdes: 'U1',
      value: 'X',
      part_number: 'X',
      source_ids: ['detail/g1.json'],
      package: '',
    }, {
      datasheet: () => ({
        part_number: 'X',
        expected: 5,
        groups: [[
          { physicalNumber: '1', type: 'in' },
          { physicalNumber: '2', type: 'out' },
          { physicalNumber: '3', type: 'power' },
          { physicalNumber: '4', type: 'bidir' },
          { physicalNumber: '5', type: 'vendor-specific' },
        ]],
      }),
    })
    expect(model.libOf('IC:X')?.pins.map((pin) => pin.type)).toEqual([
      'input', 'output', 'power_in', 'bidirectional', 'unspecified',
    ])
  })

  it('keeps engine-vocabulary electrical types verbatim (power_out survives)', () => {
    // Datasheet artifacts author `power_out` (AMS1117 VOUT in the real shape block);
    // it is already engine vocabulary, so it must not collapse to `unspecified`.
    const block = datasheetShapeBlock('REG', {
      part_number: 'REG',
      expected: 3,
      groups: [[
        { physicalNumber: '1', name: 'GND', type: 'ground' },
        { physicalNumber: '2', name: 'VOUT', type: 'power_out' },
        { physicalNumber: '3', name: 'VIN', type: 'power_in' },
      ]],
    })
    expect(block.pins.map((pin) => pin.electrical)).toEqual(['power_in', 'power_out', 'power_in'])
  })

  it('selects the datasheet lane from detail source anchors', () => {
    const model = emptyModel()
    const host: OpHost = { datasheet: () => ({ part_number: 'X', expected: 2, groups: [[{ physicalNumber: '1' }], [{ physicalNumber: '2' }]] }) }
    // `detail/<group_id>.json` anchors select the datasheet lane (8-spec §2.1).
    expectError(() => placeSymbol(model, { refdes: 'U1', value: 'X', source_ids: ['detail/g1.json'] }, host), 'datasheet_missing')
    // Anchors without the `.json` suffix do not select the datasheet lane.
    expectError(() => placeSymbol(model, { refdes: 'U1', value: 'X', source_ids: ['detail/pins'] }, host), 'symbol_unsupported')
    expectError(() => placeSymbol(model, { refdes: 'U1', value: 'X', part_number: 'X', source_ids: [] }, host), 'symbol_unsupported')
  })
})

describe('connect_pins (8-spec §3)', () => {
  function wiredModel(): Model {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, noHost)
    return model
  }

  it('routes an L path between two pins and merges them into one net', () => {
    const model = wiredModel()
    const result = connectPins(model, { endpoints: [['R1.2', 'C1.1']] })
    expect(result.wires).toHaveLength(1)
    // R1.2 world = (25.4, 29.21); C1.1 at second slot (32.512, 25.4) → pin1 world y = 25.4-3.81=21.59
    const r1p2 = model.resolvePin('R1.2').world
    const c1p1 = model.resolvePin('C1.1').world
    expect(result.wires[0]?.path[0]).toEqual(r1p2)
    expect(result.wires[0]?.path[result.wires[0].path.length - 1]).toEqual(c1p1)
    expect(model.file.wires.length).toBeGreaterThanOrEqual(1)
    const nets = model.view.nets
    expect(nets).toHaveLength(1)
    expect(nets[0]?.members.map((m) => m.pinName).sort()).toEqual(['1', '2'])
  })

  it('rejects endpoints that are already connected (connected_endpoint)', () => {
    const model = wiredModel()
    connectPins(model, { endpoints: [['R1.2', 'C1.1']] })
    expectError(() => connectPins(model, { endpoints: [['R1.2', 'C1.1']] }), 'connected_endpoint')
  })

  it('adds a junction when an endpoint lands inside an existing wire (KiCad T)', () => {
    // 回归（2026-09-13 实测）：以前这种情况直接抛 path_not_found「add a junction」，而八件写
    // 工具没有加 junction 的能力 → producer 只能反复 remove_component 重画（一次跑 1089 次调用、
    // 31 次同一个错误而不收敛）。现在按 KiCad 语义落一个 junction 标记。
    const model = wiredModel()
    const pin = model.resolvePin('R1.1')
    const at = pin.world
    model.file.wires.push({
      pts: [{ x: at.x - 2540, y: at.y }, { x: at.x + 2540, y: at.y }],
      uuid: 'probe-wire-through-pin',
    })
    connectPins(model, { endpoints: [['R1.1', 'C1.1']] })
    expect(model.file.junctions.some((junction) => junction.at.x === at.x && junction.at.y === at.y)).toBe(true)
  })

  it('rejects a duplicate endpoint (duplicate_endpoint)', () => {
    const model = wiredModel()
    expectError(() => connectPins(model, { endpoints: [['R1.2', 'R1.2']] }), 'duplicate_endpoint')
  })

  it('rejects too_few_endpoints', () => {
    expectError(() => connectPins(wiredModel(), { endpoints: [] }), 'too_few_endpoints')
  })

  it('chains three pins into one net', () => {
    const model = wiredModel()
    placeSymbol(model, { refdes: 'R2', value: '10k', kind: 'sym2' }, noHost)
    const result = connectPins(model, { endpoints: [['R1.2', 'C1.1'], ['C1.1', 'R2.1']] })
    expect(result.wires).toHaveLength(2)
    expect(model.view.nets).toHaveLength(1)
    expect(model.view.nets[0]?.members).toHaveLength(3)
  })
})

describe('place_label / place_power_symbol / place_no_connect (8-spec §4-§6)', () => {
  it('labels a lone pin and names its net', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    const result = placeLabel(model, { name: 'NET1', endpoint: 'R1.1' })
    expect(model.file.labels).toHaveLength(1)
    expect(model.file.labels[0]).toMatchObject({ text: 'NET1' })
    expect(result.net.name).toBe('NET1')
    expect(result.net.members).toEqual(['R1.1'])
    expect(model.view.nets[0]?.labelled).toBe(true)
  })

  it('joins nets by the same label name (KiCad idiom)', () => {
    // 2026-09-13 改：同名 label 不再算重复，而是**按名连接**（deriver 按 label 文本合并网络）。
    // 旧规则实测把 producer 唯一的"按名连接"通道堵死，导致晶振悬空交付。
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placeSymbol(model, { refdes: 'R2', value: '10k', kind: 'sym2' }, noHost)
    placeLabel(model, { name: 'NET1', endpoint: 'R1.1' })
    const second = placeLabel(model, { name: 'NET1', endpoint: 'R2.1' })
    expect(second.net.name).toBe('NET1')
    // 两个点必须落在同一个名为 NET1 的网络里（按名连接成立）。
    const net = model.view.nets.find((candidate) => candidate.name === 'NET1')
    expect(net?.members.map((member) => member.pinName ?? member.refdes).length).toBeGreaterThanOrEqual(2)
  })

  it('still refuses to rename a differently named net', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placeSymbol(model, { refdes: 'R2', value: '10k', kind: 'sym2' }, noHost)
    connectPins(model, { endpoints: [['R1.1', 'R2.1']] })
    placeLabel(model, { name: 'NET1', endpoint: 'R1.1' })
    expectError(() => placeLabel(model, { name: 'OTHER', endpoint: 'R2.1' }), 'duplicate_net_name')
  })

  it('places a power symbol at a pin and creates the global net', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, noHost)
    const result = placePowerSymbol(model, { name: 'GND', endpoint: 'C1.2' })
    expect(result.net.name).toBe('GND')
    expect([...result.net.members].sort()).toEqual(['#PWR01.1', 'C1.2'])
    const pwr = model.file.symbols.find((s) => (s.properties.Reference ?? '').startsWith('#PWR'))
    expect(pwr?.properties.Value).toBe('GND')
    expect(model.libOf('cicada:GND')?.power).toBe(true)
    // Second power symbol on a different pin gets the next #PWR number.
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placePowerSymbol(model, { name: '3V3', endpoint: 'R1.1' })
    const refs = model.file.symbols.map((s) => s.properties.Reference).filter((r) => r.startsWith('#PWR')).sort()
    expect(refs).toEqual(['#PWR01', '#PWR02'])
  })

  it('marks a lone pin as no-connect and rejects a second marker', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    const result = placeNoConnect(model, { endpoint: 'R1.1' })
    expect(result.ok).toBe(true)
    expect(model.file.noConnects).toHaveLength(1)
    expect(model.file.noConnects[0]?.at).toEqual(model.resolvePin('R1.1').world)
    expectError(() => placeNoConnect(model, { endpoint: 'R1.1' }), 'no_connect_conflict')
  })

  it('declared output schemas accept what the ops actually return', () => {
    // Probes 4/5 both saw `place_power_symbol` report a schema violation for a write
    // that had landed: the `net` view was declared as an empty object under
    // `additionalProperties: false`. Validate the real results against the declared
    // schemas so an under-declared output fails here instead of in front of a model.
    const stubHost = { perform: () => Promise.reject(new Error('not executed')) } as unknown as CicadaToolHost
    const schemaOf = (name: string): unknown => {
      const tool = cicadaWriteTools(stubHost, noHost).find((candidate) => candidate.name === name)
      expect(tool, `tool ${name} is registered`).toBeDefined()
      return tool?.output?.schema
    }
    const asResult = <T extends object>(value: T): unknown => ({ ok: true, message: 'ok', ...value })

    const model = emptyModel()
    placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, noHost)
    const power = placePowerSymbol(model, { name: 'GND', endpoint: 'C1.2' })
    expect(validateJsonSchemaValue(schemaOf('place_power_symbol') as never, asResult(power))).toEqual([])
    const label = placeLabel(model, { name: 'NET1', endpoint: 'C1.1' })
    expect(validateJsonSchemaValue(schemaOf('place_label') as never, asResult(label))).toEqual([])
  })

  it('place_symbol accepts a library-lane call without source_ids', () => {
    // source_ids belongs to the datasheet lane; requiring it in the schema made the
    // producer retry a library-lane placement with an empty array (probe 6).
    const tool = cicadaWriteTools(
      { perform: () => Promise.reject(new Error('not executed')) } as unknown as CicadaToolHost,
      noHost,
    ).find((candidate) => candidate.name === 'place_symbol')
    expect(tool).toBeDefined()
    // `ToolDefinition.parameters` is the compiled JSON Schema the model receives.
    const violations = validateJsonSchemaValue(tool?.parameters as never, { refdes: 'R1', value: '10k', lib_id: 'R:R' })
    expect(violations).toEqual([])
  })

  it('rejects no-connect on a connected pin (connected_endpoint)', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, noHost)
    connectPins(model, { endpoints: [['R1.2', 'C1.1']] })
    expectError(() => placeNoConnect(model, { endpoint: 'R1.2' }), 'connected_endpoint')
  })
})

describe('disconnect / set_property / remove_component (8-spec §7-§9)', () => {
  function connectedModel(): Model {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, noHost)
    connectPins(model, { endpoints: [['R1.2', 'C1.1']] })
    return model
  }

  it('disconnects with CAS and removes only the wire segments touching the pin (8-spec §7.2)', () => {
    const model = connectedModel()
    const before = model.file.wires.length
    expect(before).toBeGreaterThan(0)
    const result = disconnect(model, { endpoint: 'R1.2', expected_net: model.view.nets[0]?.name ?? '' })
    expect(result.nets.length).toBe(1)
    // Only segments with an endpoint at the pin point are removed; the far
    // side keeps its stub (no junction splicing in v1).
    expect(model.file.wires).toHaveLength(before - 1)
    expect(model.view.nets).toHaveLength(0)
  })

  it('rejects disconnect with a stale expected net (expected_net_mismatch)', () => {
    const model = connectedModel()
    expectError(() => disconnect(model, { endpoint: 'R1.2', expected_net: 'NOT_THE_NET' }), 'expected_net_mismatch')
    // File untouched on failure.
    expect(model.file.wires.length).toBeGreaterThan(0)
  })

  it('rejects disconnect of an unconnected pin', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    expectError(() => disconnect(model, { endpoint: 'R1.1', expected_net: 'NET1' }), 'endpoint_not_connected')
  })

  it('sets properties and renames refdes with uniqueness', () => {
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    setProperty(model, { refdes: 'R1', property: 'Value', value: '4.7k' })
    expect(model.symbolByRefdes('R1')?.properties.Value).toBe('4.7k')
    setProperty(model, { refdes: 'R1', property: 'Reference', value: 'R9' })
    expect(model.symbolByRefdes('R9')).toBeDefined()
    placeSymbol(model, { refdes: 'C1', value: '100nF', kind: 'sym2' }, noHost)
    expectError(() => setProperty(model, { refdes: 'C1', property: 'Reference', value: 'R9' }), 'duplicate_refdes')
    expectError(() => setProperty(model, { refdes: 'NOPE', property: 'Value', value: 'x' }), 'unknown_refdes')
  })

  it('removes a component with its labels, NC markers, and orphan wires', () => {
    const model = connectedModel()
    placeLabel(model, { name: 'NET1', endpoint: 'R1.2' })
    const result = removeComponent(model, { refdes: 'R1' })
    expect(result.removed).toEqual(['R1'])
    expect(model.symbolByRefdes('R1')).toBeUndefined()
    expect(model.file.labels).toHaveLength(0)
    // The wire segment touching R1.2 is orphaned (other end not a survivor
    // anchor) and deleted; the C1-side stub segments are kept (8-spec §9.2).
    expect(model.file.wires.length).toBeGreaterThanOrEqual(1)
    expect(model.view.nets).toHaveLength(0)
  })

  it('rejects removal of an unknown refdes without changes', () => {
    const model = emptyModel()
    expectError(() => removeComponent(model, { refdes: 'Z9' }), 'unknown_refdes')
  })
})

describe('datasheet lane anchors and engine-vocabulary normalization', () => {
  it('accepts both the canonical detail/<group>.json and the bare group id', () => {
    expect(isDetailAnchor('detail/pinout.json')).toBe(true)
    expect(isDetailAnchor('pinout')).toBe(true)
    expect(isDetailAnchor('PIN-001')).toBe(true)
    // Path-shaped or free-text values are not anchors: they must not silently
    // select the datasheet lane.
    expect(isDetailAnchor('detail/')).toBe(false)
    expect(isDetailAnchor('a/b')).toBe(false)
    expect(isDetailAnchor('two words')).toBe(false)
  })

  it('selects the datasheet lane from a bare group id (producer reads group ids)', () => {
    const model = emptyModel()
    const host: OpHost = {
      datasheet: () => ({
        part_number: 'X',
        expected: 3,
        groups: [[
          { physicalNumber: '1', name: 'GND', type: 'ground' },
          { physicalNumber: '2', name: 'VOUT', type: 'power_out' },
          { physicalNumber: '3', name: 'VIN', type: 'power_in' },
        ]],
      }),
    }
    const placed = placeSymbol(model, { refdes: 'U1', value: 'X', part_number: 'X', source_ids: ['pinout'] }, host)
    expect(placed.lib_id).toBe('IC:X')
  })

  it('normalizes electrical and side vocabulary before the engine sees the block', () => {
    const block = toEngineBlock({
      name: 'STM32F103C8T6',
      pins: [
        { number: '1', name: 'VBAT', electrical: 'power', side: 'L' },
        { number: '2', name: 'PC13', electrical: 'bidir', side: 'Right' },
        { number: '3', name: 'X', electrical: 'power_out', side: 'diagonal' },
      ],
    })
    expect(block.pins.map((pin) => pin.number)).toEqual(['1', '2', '3'])
    expect(block.pins.map((pin) => pin.electrical)).toEqual(['power_in', 'bidirectional', 'power_out'])
    expect(block.pins.map((pin) => pin.side)).toEqual(['left', 'right', 'diagonal'])
  })

  it('names the whole placement contract when no lane matches (was: unknown template kind "")', () => {
    const model = emptyModel()
    let message = ''
    try {
      placeSymbol(model, { refdes: 'U1', value: 'X' }, noHost)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('lib_id (library lane)')
    expect(message).toContain('part_number + source_ids (datasheet lane')
  })
})

describe('placement (8-spec §2.4): integer grid and occupancy avoidance', () => {
  it('lands on integer G coordinates for every symbol, whatever its size', () => {
    const model = emptyModel()
    for (const refdes of ['R1', 'C1', 'R2', 'C2', 'R3']) {
      placeSymbol(model, { refdes, value: '1', kind: 'sym2' }, noHost)
    }
    for (const symbol of model.file.symbols) {
      expect(Number.isInteger(symbol.at.x), `${symbol.properties.Reference} x=${String(symbol.at.x)}`).toBe(true)
      expect(Number.isInteger(symbol.at.y), `${symbol.properties.Reference} y=${String(symbol.at.y)}`).toBe(true)
    }
  })

  it('skips a slot that is already occupied instead of stacking on it', () => {
    // 2026-09-13：落位以前只按"第几个元件"排队，不看已有几何 → 压格后只能靠绕线硬扛。
    const model = emptyModel()
    placeSymbol(model, { refdes: 'R1', value: '10k', kind: 'sym2' }, noHost)
    const first = model.file.symbols[0]!
    const boxOf = (symbol: typeof first) => {
      const lib = model.libOf(symbol.libId)
      return lib === undefined ? { w: 0, h: 0 } : bboxOf(lib)
    }
    const plainSecond = nextPlacement([boxOf(first)])
    placeSymbol(model, { refdes: 'R2', value: '10k', kind: 'sym2' }, noHost)
    const second = model.file.symbols[1]!
    expect(second.at).not.toEqual(plainSecond)
    // 且不能与第一个的占地盒重叠（同一套"以原点为中心"的近似，和落位判定一致）。
    const a = boxOf(first)
    const b = boxOf(second)
    const overlapX = Math.abs(second.at.x - first.at.x) < (a.w + b.w) / 2
    const overlapY = Math.abs(second.at.y - first.at.y) < (a.h + b.h) / 2
    expect(overlapX && overlapY).toBe(false)
  })
})
