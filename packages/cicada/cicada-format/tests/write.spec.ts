import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parse } from '../src/read.ts'
import { serialize } from '../src/write.ts'

const minimal = readFileSync(new URL('./fixtures/minimal.cicada_sch', import.meta.url), 'utf8')

describe('serialize', () => {
  it('emits a canonical roundtrip-equal document (semantic stability)', () => {
    const once = serialize(parse(minimal))
    const twice = serialize(parse(once))
    expect(twice).toBe(once)
  })

  it('preserves coordinates at two-decimal precision', () => {
    const text = serialize(parse(minimal))
    expect(text).toContain('(at 14.40 19.60 0)')
    expect(text).toContain('(xy 25.40 30.48)')
  })

  it('keeps library symbol bodies intact (token-level check after normalization)', () => {
    const text = serialize(parse(minimal))
    expect(text).toContain('(symbol "cicada:R"')
    expect(text).toContain('(rectangle')
    expect(text).toContain('(start -1.016 -2.54)')
    expect(text).toContain('(end 1.016 2.54)')
    expect(text).toContain('(pin passive line (at 0 3.81 270) (length 1.27) (name "") (number "1"))')
  })

  it('writes explicit pin uuids and the sheet_instances section', () => {
    const text = serialize(parse(minimal))
    expect(text).toContain('(pin "1" (uuid bbbbbbbb-1111-0000-0000-000000000002))')
    expect(text).toContain('(sheet_instances (path "/" (page "1")))')
  })

  it('parses a parsed+serialized document back to the same semantic model', () => {
    const original = parse(minimal)
    const rerun = parse(serialize(original))
    expect(rerun).toEqual(original)
  })
})
