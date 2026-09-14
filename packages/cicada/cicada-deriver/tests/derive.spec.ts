import { readFileSync } from 'node:fs'

import { parse } from '@deepseek-ai/dsh-cicada-format'
import { describe, expect, it } from 'vitest'

import { derive } from '../src/view.ts'

const minimal = readFileSync(new URL('../../cicada-format/tests/fixtures/minimal.cicada_sch', import.meta.url), 'utf8')
const corrected = readFileSync(new URL('../../cicada-format/tests/fixtures/corrected.cicada_sch', import.meta.url), 'utf8')

const LIB_R = `(symbol "cicada:R" (pin_numbers (hide yes)) (pin_names (offset 0))
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
  (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "" ) (number "1" ))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "" ) (number "2" ))))`

const LIB_GND = `(symbol "cicada:GND" (power) (pin_numbers (hide yes)) (pin_names (offset 0) hide)
  (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))))
  (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (name "~" ) (number "1" ))))`

const mm = (v: number): string => v.toFixed(2)

function symbol(libId: string, x: number, y: number, ref: string, value: string): string {
  return `(symbol (lib_id "${libId}") (at ${mm(x)} ${mm(y)} 0) (unit 1)
    (uuid u-${ref}) (property "Reference" "${ref}" (at ${mm(x)} ${mm(y)} 0)) (property "Value" "${value}" (at ${mm(x)} ${mm(y)} 0))
    (pin "1" (uuid p-${ref}-1)) (pin "2" (uuid p-${ref}-2)))`
}

function wire(a: [number, number], b: [number, number], id: string): string {
  return `(wire (pts (xy ${mm(a[0])} ${mm(a[1])}) (xy ${mm(b[0])} ${mm(b[1])})) (uuid w-${id}))`
}

function file(libs: string, items: string[], version = 20250114): string {
  return `(kicad_sch (version ${version}) (generator "cicada") (generator_version "0.1")
  (uuid root) (lib_symbols ${libs}) ${items.join('\n  ')}
  (sheet_instances (path "/" (page "1"))))`
}

// Coordinates in the synthetic schematics are mm strings; values below are in mm.
describe('derive', () => {
  it('derives the golden minimal file: NET1 = {C1.2}, others floating', () => {
    const model = derive(parse(minimal))
    expect(model.nets).toEqual([{ name: 'NET1', members: [{ refdes: 'C1', pinName: '2', physicalNumber: '2' }], labelled: true, power: false }])
    expect(model.labels).toEqual(['NET1'])
    expect(model.noConnects).toEqual([])
    expect(model.components.map((c) => c.refdes)).toEqual(['R1', 'C1'])
  })

  it('derives the corrected golden file: NET1 = {C1.1, R1.2}', () => {
    const model = derive(parse(corrected))
    expect(model.nets).toEqual([
      {
        name: 'NET1',
        members: [
          { refdes: 'C1', pinName: '1', physicalNumber: '1' },
          { refdes: 'R1', pinName: '2', physicalNumber: '2' },
        ],
        labelled: true,
        power: false,
      },
    ])
  })

  it('names unnamed nets NETn by dictionary rank (stable across sessions)', () => {
    const text = file(
      LIB_R,
      [
        symbol('cicada:R', 25.4, 25.4, 'R1', '10k'),
        symbol('cicada:R', 50.8, 25.4, 'R2', '10k'),
        symbol('cicada:R', 76.2, 25.4, 'R3', '10k'),
        wire([25.4, 29.21], [50.8, 21.59], '1'),
        wire([50.8, 29.21], [76.2, 21.59], '2'),
      ],
    )
    const model = derive(parse(text))
    expect(model.nets).toEqual([
      { name: 'NET1', members: [{ refdes: 'R1', pinName: '2', physicalNumber: '2' }, { refdes: 'R2', pinName: '1', physicalNumber: '1' }], labelled: false, power: false },
      { name: 'NET2', members: [{ refdes: 'R2', pinName: '2', physicalNumber: '2' }, { refdes: 'R3', pinName: '1', physicalNumber: '1' }], labelled: false, power: false },
    ])
  })

  it('power symbols name nets by their Value globally', () => {
    const text = file(
      `${LIB_R} ${LIB_GND}`,
      [
        symbol('cicada:R', 25.4, 25.4, 'R1', '10k'),
        `(symbol (lib_id "cicada:GND") (at 25.40 29.21 0) (unit 1) (uuid u-GND) (property "Reference" "#PWR01" (at 25.4 29.21 0)) (property "Value" "GND" (at 25.4 29.21 0)) (pin "1" (uuid p-GND1)))`,
      ],
    )
    const model = derive(parse(text))
    expect(model.nets).toEqual([{ name: 'GND', members: [{ refdes: '#PWR01', pinName: '1', physicalNumber: '1' }, { refdes: 'R1', pinName: '2', physicalNumber: '2' }], labelled: false, power: true }])
  })

  it('a #PWR symbol names its net even when the lib entry lost the (power) flag', () => {
    // 2026-09-08 验收实测：引擎保存回写曾把 lib 条目的 (power) 丢掉，语义层随即
    // 把 GND 退化成 NETn。KiCad 的 #PWR Reference 约定是第二判据。
    const gndNoFlag = LIB_GND.replace(' (power)', '')
    const text = file(
      `${LIB_R} ${gndNoFlag}`,
      [
        symbol('cicada:R', 25.4, 25.4, 'R1', '10k'),
        `(symbol (lib_id "cicada:GND") (at 25.40 29.21 0) (unit 1) (uuid u-GND) (property "Reference" "#PWR01" (at 25.4 29.21 0)) (property "Value" "GND" (at 25.4 29.21 0)) (pin "1" (uuid p-GND1)))`,
      ],
    )
    const model = derive(parse(text))
    expect(model.nets).toEqual([{ name: 'GND', members: [{ refdes: '#PWR01', pinName: '1', physicalNumber: '1' }, { refdes: 'R1', pinName: '2', physicalNumber: '2' }], labelled: false, power: true }])
  })

  it('detects no-connect pins', () => {
    const text = file(
      LIB_R,
      [
        symbol('cicada:R', 25.4, 25.4, 'R1', '10k'),
        `(no_connect (at 25.40 45.72) (uuid nc-1))`,
        wire([25.4, 29.21], [25.4, 41.91], '1'),
        symbol('cicada:R', 25.4, 50.8, 'R2', '10k'),
        wire([25.4, 46.99], [25.4, 44.45], '2'),
      ],
    )
    const model = derive(parse(text))
    expect(model.noConnects).toEqual([])
    // Place a no_connect exactly on R2.1 (50.8 - 3.81 = 46.99).
    const text2 = file(LIB_R, [symbol('cicada:R', 25.4, 50.8, 'R2', '10k'), `(no_connect (at 25.40 46.99) (uuid nc-2))`])
    expect(derive(parse(text2)).noConnects).toEqual([{ refdes: 'R2', pinName: '1', physicalNumber: '1' }])
  })

  it('component pins carry the library canonical name (physical number when unnamed)', () => {
    const LIB_IC = `(symbol "IC:AMS1117" (pin_names (offset 0.508))
  (symbol "AMS1117_0_1" (rectangle (start -1.27 -1.27) (end 1.27 1.27)))
  (symbol "AMS1117_1_1"
    (pin passive line (at 0 -3.81 90) (length 2.54) (name "GND" ) (number "1" ))
    (pin passive line (at 3.81 0 180) (length 2.54) (name "VOUT" ) (number "2" ))
    (pin passive line (at -3.81 0 0) (length 2.54) (name "VIN" ) (number "3" ))))`
    const inst = `(symbol (lib_id "IC:AMS1117") (at 25.4 25.4 0) (unit 1)
    (uuid u-u1) (property "Reference" "U1" (at 25.4 25.4 0)) (property "Value" "AMS1117-3.3" (at 25.4 25.4 0))
    (pin "1" (uuid p1)) (pin "2" (uuid p2)) (pin "3" (uuid p3)))`
    expect(derive(parse(file(LIB_IC, [inst]))).components[0]?.pins).toEqual([
      { number: '1', name: 'GND' },
      { number: '2', name: 'VOUT' },
      { number: '3', name: 'VIN' },
    ])
    // 无名字引脚（R/C 的 1-2）回退到物理号，token 词汇与 connect.ts pinName 一致。
    expect(derive(parse(minimal)).components[0]?.pins).toEqual([
      { number: '1', name: '1' },
      { number: '2', name: '2' },
    ])
  })
})
