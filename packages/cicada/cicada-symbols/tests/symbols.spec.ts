import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse, validate } from '@deepseek-ai/dsh-cicada-format'
import { describe, expect, it } from 'vitest'

import { SymbolCache } from '../src/cache.ts'
import { pinUniverse } from '../src/datasheet.ts'
import { assignSides, icBox, icPins } from '../src/geometry.ts'
import { buildTemplate } from '../src/templates.ts'
import { sideToEngine } from '../src/datasheet.ts'

function wrap(texts: string[], version = 20260803): string {
  return `(kicad_sch (version ${version}) (generator "cicada") (generator_version "0.1")\n  (uuid root-uuid)\n  (lib_symbols\n${texts.join('\n')}\n  )\n  (sheet_instances (path "/" (page "1"))))`
}

/** 取第一个元素并保证存在（noUncheckedIndexedAccess 下索引结果可能 undefined）。 */
const firstLib = <T>(items: readonly T[]): T => {
  const item = items[0]
  if (item === undefined) throw new Error('expected at least one lib symbol')
  return item
}

describe('geometry', () => {
  it('distributes pins per 8-spec §2.5 (four edges, physical order, counter-clockwise)', () => {
    expect(assignSides(4)).toEqual({ top: 1, right: 1, bottom: 1, left: 1 })
    expect(assignSides(8)).toEqual({ top: 2, right: 2, bottom: 2, left: 2 })
    expect(assignSides(48)).toEqual({ top: 12, right: 12, bottom: 12, left: 12 })
    expect(assignSides(50)).toEqual({ top: 13, right: 13, bottom: 13, left: 11 })
  })

  it('produces symmetric integer-G box sizes', () => {
    expect(icBox(4)).toEqual({ perSide: 1, sides: { top: 1, right: 1, bottom: 1, left: 1 }, width: 254, height: 254 })
    expect(icBox(8).width).toBe(382)
    expect(icBox(8).width % 2).toBe(0)
    expect(icBox(50).width).toBe(1778)
  })

  it('generates 4-pin IC pins on exact grid with correct angles and symmetry', () => {
    const pins = icPins(4)
    expect(pins.map((p) => p.number)).toEqual(['1', '2', '3', '4'])
    expect(pins[0]).toMatchObject({ at: { x: 0, y: 381 }, angle: 270, length: 254 })
    expect(pins[1]).toMatchObject({ at: { x: 381, y: 0 }, angle: 180 })
    expect(pins[2]).toMatchObject({ at: { x: 0, y: -381 }, angle: 90 })
    expect(pins[3]).toMatchObject({ at: { x: -381, y: 0 }, angle: 0 })
  })

  it('keeps every 8-pin IC coordinate an integer G with mirrored symmetry', () => {
    const pins = icPins(8)
    const pair = (p: { at: { x: number; y: number } }): boolean => Number.isInteger(p.at.x) && Number.isInteger(p.at.y)
    expect(pins.every(pair)).toBe(true)
    expect(pins[0].at.x).toBe(-pins[1].at.x)
    expect(pins[0].at.y).toBe(pins[1].at.y)
    expect(pins[2].at.x).toBe(pins[3].at.x)
    expect(pins[2].at.y).toBe(-pins[3].at.y)
  })
})

describe('pinUniverse', () => {
  it('accepts a complete contiguous universe', () => {
    const result = pinUniverse([[{ physicalNumber: '1' }, { physicalNumber: '2' }], [{ physicalNumber: '3' }]], 3)
    expect(result.complete).toBe(true)
    expect(result.errorCode).toBeUndefined()
  })

  it('rejects duplicates across groups', () => {
    expect(pinUniverse([[{ physicalNumber: '1' }], [{ physicalNumber: '1' }]]).complete).toBe(false)
  })

  it('rejects gaps', () => {
    expect(pinUniverse([[{ physicalNumber: '1' }, { physicalNumber: '2' }, { physicalNumber: '4' }]]).complete).toBe(false)
  })

  it('rejects when the expected count is not reached', () => {
    expect(pinUniverse([[{ physicalNumber: '1' }, { physicalNumber: '2' }]], 8).errorCode).toBe('pin_universe_incomplete')
  })

  it('rejects a contiguous universe that does not start at 1', () => {
    expect(pinUniverse([[{ physicalNumber: '2' }, { physicalNumber: '3' }]]).complete).toBe(false)
  })
})

describe('templates', () => {
  it('sym2 generates a parseable, valid lib symbol', () => {
    const t = buildTemplate('sym2', 'R')
    const file = parse(wrap([t.text]))
    expect(validate(file).ok).toBe(true)
    expect(firstLib(file.libSymbols).pins.map((p) => p.number)).toEqual(['1', '2'])
    expect(firstLib(file.libSymbols).pins[0]).toMatchObject({ at: { x: 0, y: 381 }, angle: 270 })
  })

  it('power generates a power symbol with one power_in pin at the origin', () => {
    const t = buildTemplate('power', 'GND')
    const file = parse(wrap([t.text]))
    expect(validate(file).ok).toBe(true)
    expect(firstLib(file.libSymbols).power).toBe(true)
    expect(firstLib(file.libSymbols).pins[0]).toMatchObject({ number: '1', at: { x: 0, y: 0 }, length: 0, type: 'power_in' })
  })

  it('icPins templates embed a lib body KiCad can keep (parseable + naming valid)', () => {
    const t = buildTemplate('sym2', 'R')
    const file = parse(wrap([t.text]))
    expect(firstLib(file.libSymbols).body.children.some((c) => (c as { head?: string }).head === 'symbol')).toBe(true)
  })
})

describe('cache', () => {
  it('stores and loads entries roundtrip in an injected root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cicada-symbols-'))
    try {
      const cache = new SymbolCache(root)
      expect(cache.load('R')).toBeUndefined()
      cache.store('R', '(symbol "cicada:R" (power))')
      expect(cache.load('R')).toBe('(symbol "cicada:R" (power))')
      cache.store('R', '(symbol "cicada:R" (power) (boom))')
      expect(cache.load('R')).toBe('(symbol "cicada:R" (power) (boom))')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unsafe cache names', () => {
    const cache = new SymbolCache(tmpdir())
    expect(() => cache.load('../R')).toThrow(TypeError)
    expect(() => cache.store('a/b', 'x')).toThrow(TypeError)
  })
})

describe('sideToEngine', () => {
  it('accepts the canonical four, case-insensitively', () => {
    for (const side of ['left', 'Right', 'TOP', 'bottom']) {
      expect(sideToEngine(side)).toBe(side.toLowerCase())
    }
  })

  it('maps the single-letter forms the datasheet agents actually write', () => {
    expect(sideToEngine('L')).toBe('left')
    expect(sideToEngine('r')).toBe('right')
    expect(sideToEngine('T')).toBe('top')
    expect(sideToEngine('B')).toBe('bottom')
  })

  it('passes an unknown side through so the engine still rejects it loudly', () => {
    expect(sideToEngine('diagonal')).toBe('diagonal')
    expect(sideToEngine('')).toBeUndefined()
    expect(sideToEngine(undefined)).toBeUndefined()
  })
})
