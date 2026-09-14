import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FormatError, parse } from '../src/read.ts'

const minimal = readFileSync(new URL('./fixtures/minimal.cicada_sch', import.meta.url), 'utf8')

describe('parse', () => {
  it('parses the minimal golden file into a typed model', () => {
    const file = parse(minimal)
    expect(file.version).toBe(20250114)
    expect(file.generator).toBe('cicada')
    expect(file.generatorVersion).toBe('0.1')
    expect(file.uuid).toBe('11111111-2222-3333-4444-555555555555')
    expect(file.hasSheetInstances).toBe(true)
    expect(file.paper).toBeUndefined()

    expect(file.libSymbols.map((s) => s.libId)).toEqual(['cicada:R', 'cicada:C'])
    const r = file.libSymbols[0]
    expect(r.power).toBe(false)
    expect(r.pinNumbersHidden).toBe(true)
    expect(r.pins).toHaveLength(2)
    expect(r.pins[0]).toMatchObject({ number: '1', name: '', type: 'passive', shape: 'line', at: { x: 0, y: 381 }, angle: 270, length: 127 })

    expect(file.symbols).toHaveLength(2)
    expect(file.symbols[0]).toMatchObject({ libId: 'cicada:R', at: { x: 1440, y: 1960 }, rotation: 0, unit: 1 })
    expect(file.symbols[0].properties.Reference).toBe('R1')
    expect(file.symbols[0].properties.Value).toBe('10k')
    expect(file.symbols[0].pins.map((p) => p.number)).toEqual(['1', '2'])

    expect(file.wires).toHaveLength(1)
    expect(file.wires[0].pts).toEqual([
      { x: 2540, y: 3048 },
      { x: 3610, y: 2401 },
    ])
    expect(file.labels[0]).toMatchObject({ text: 'NET1', at: { x: 2540, y: 3048 }, rotation: 0 })
    expect(file.noConnects[0].at).toEqual({ x: 2540, y: 4572 })
  })

  it('derives the sub-symbol name from the library key tail (category:name)', () => {
    // 引擎/文件层写的是键化条目（docs/09 §1）：`C:C_Small` 的单元体只带 name。
    const file = parse(
      '(kicad_sch (version 20250114) (generator "cicada") (generator_version "0.1")\n'
      + '  (lib_symbols\n'
      + '    (symbol "C:C_Small" (pin_numbers (hide yes)) (pin_names (offset 0))\n'
      + '      (property "Reference" "" (at 2.032 0 90)) (property "Value" "C_Small" (at 0 0 90))\n'
      + '      (symbol "C_Small_0_1") (symbol "C_Small_1_1"\n'
      + '        (pin passive line (at 0.00 2.54 270) (length 2.03) (name "") (number "1"))\n'
      + '        (pin passive line (at 0.00 -2.54 90) (length 2.03) (name "") (number "2")))))\n'
      + ')\n',
    )
    const c = file.libSymbols[0]
    expect(c.libId).toBe('C:C_Small')
    expect(c.name).toBe('C_Small')
    expect(c.pins.map((pin) => pin.number)).toEqual(['1', '2'])
    expect(c.pins[0]).toMatchObject({ at: { x: 0, y: 254 }, angle: 270, length: 203 })
  })

  it('fails closed on whitelisted-out top-level tokens', () => {
    expect(() => parse('(kicad_sch (version 20250114) (bus (pts (xy 0 0) (xy 1 1))))')).toThrowError(
      expect.objectContaining({ code: 'symbol_unsupported' }),
    )
  })

  it('fails closed on mirror inside a symbol instance', () => {
    const text = '(kicad_sch (version 20250114) (symbol (lib_id "cicada:R") (at 0 0 0) (mirror x)))'
    expect(() => parse(text)).toThrow(FormatError)
  })

  it('fails closed on non-whitelisted rotation angles', () => {
    const text = '(kicad_sch (version 20250114) (symbol (lib_id "cicada:R") (at 0 0 45)))'
    expect(() => parse(text)).toThrow(FormatError)
  })

  it('fails closed on multi-unit symbols', () => {
    const text = '(kicad_sch (version 20250114) (symbol (lib_id "cicada:X") (at 0 0 0) (unit 2)))'
    expect(() => parse(text)).toThrow(FormatError)
  })

  it('rejects text without a version', () => {
    expect(() => parse('(kicad_sch (generator "cicada"))')).toThrow(FormatError)
  })

  it('tolerates connectivity-neutral optional fields inside symbols', () => {
    const text =
      '(kicad_sch (version 20250114) (lib_symbols (symbol "cicada:R" (symbol "R_1_1" (pin passive line (at 0 0 0) (length 0) (name "a") (number "1"))))) (symbol (lib_id "cicada:R") (at 0 0 0) (unit 1) (uuid u) (property "Reference" "R1" (at 0 0 0)) (property "Value" "R" (at 0 0 0)) (pin "1" (uuid p)) (in_bom yes) (on_board yes)))'
    const file = parse(text)
    expect(file.symbols[0].properties.Value).toBe('R')
  })
})
