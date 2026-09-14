import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parse } from '../src/read.ts'
import { validate } from '../src/validate.ts'

const minimal = readFileSync(new URL('./fixtures/minimal.cicada_sch', import.meta.url), 'utf8')

describe('validate', () => {
  it('accepts the minimal golden file', () => {
    expect(validate(parse(minimal)).ok).toBe(true)
  })

  it('rejects unknown lib_id references', () => {
    const file = parse(minimal)
    file.symbols[0] = { ...file.symbols[0], libId: 'cicada:NO_SUCH_SYMBOL' }
    const result = validate(file)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.code === 'unknown_lib_id')).toBe(true)
  })

  it('rejects duplicate refdes', () => {
    const file = parse(minimal)
    file.symbols[1] = { ...file.symbols[1], properties: { ...file.symbols[1].properties, Reference: 'R1' } }
    expect(validate(file).errors.some((e) => e.code === 'duplicate_refdes')).toBe(true)
  })

  it('rejects badly named sub-symbols', () => {
    const file = parse(minimal)
    file.libSymbols[0] = { ...file.libSymbols[0], name: 'R', body: structuredClone(file.libSymbols[0].body) }
    const body = file.libSymbols[0].body
    const graph = body.children.find((c) => (c as { head?: string }).head === 'symbol') as { head: string; children: { type: string; value: string }[] }
    graph.children[0] = { type: 'str', value: 'WRONG_0_1' }
    expect(validate(file).errors.some((e) => e.code === 'bad_sub_symbol_name')).toBe(true)
  })

  it('rejects non-cicada library namespaces', () => {
    const file = parse(minimal)
    file.libSymbols[0] = { ...file.libSymbols[0], libId: 'Device:R' }
    expect(validate(file).errors.some((e) => e.code === 'non_cicada_lib')).toBe(true)
  })

  it('rejects unsupported versions', () => {
    const file = parse(minimal)
    file.version = 12345678
    expect(validate(file).errors.some((e) => e.code === 'unsupported_version')).toBe(true)
  })
})
