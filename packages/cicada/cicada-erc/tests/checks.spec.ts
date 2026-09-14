import { describe, expect, it } from 'vitest'

import { CicadaFormat } from '@deepseek-ai/dsh-cicada-format'

import { runChecks } from '../src/checks.ts'
import { emptySchematicText } from '../../cicada-runtime/src/turn.ts'
import { Model } from '../../cicada-runtime/src/file-model.ts'
import { connectPins, placeNoConnect, placePowerSymbol, placeSymbol } from '../../cicada-runtime/src/ops.ts'

const format = new CicadaFormat({} as never)

function model(): Model {
  return new Model(format.parse(emptySchematicText()))
}

describe('erc graph checks (v1, advisory)', () => {
  it('flags unconnected pins without NC markers', () => {
    const m = model()
    placeSymbol(m, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
    const warnings = runChecks(m.file)
    expect(warnings.filter((w) => w.code === 'unconnected_pin')).toHaveLength(2)
  })

  it('accepts NC-marked pins and flags NC on a connected pin', () => {
    const m = model()
    placeSymbol(m, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
    placeSymbol(m, { refdes: 'C1', value: '100nF', kind: 'sym2' }, {})
    placeNoConnect(m, { endpoint: 'R1.1' })
    connectPins(m, { endpoints: [['R1.2', 'C1.1']] })
    const warnings = runChecks(m.file)
    expect(warnings.filter((w) => w.code === 'unconnected_pin')).toHaveLength(1)
    expect(warnings.filter((w) => w.code === 'no_connect_conflict')).toHaveLength(0)

    // A connected pair leaves exactly the two dangling pins unconnected.
    const m2 = model()
    placeSymbol(m2, { refdes: 'R1', value: '10k', kind: 'sym2' }, {})
    placeSymbol(m2, { refdes: 'C1', value: '100nF', kind: 'sym2' }, {})
    connectPins(m2, { endpoints: [['R1.2', 'C1.1']] })
    const plain = runChecks(m2.file)
    expect(plain.filter((w) => w.code === 'unconnected_pin')).toHaveLength(2)

    // Hand-inject an NC onto a connected pin (ops prevent it; erc must still flag it).
    m2.file.noConnects.push({ at: m2.resolvePin('R1.2').world, uuid: 'nc-injected' })
    const conflict = runChecks(m2.file)
    expect(conflict.filter((w) => w.code === 'no_connect_conflict')).toHaveLength(1)
  })

  it('does not flag power nets as single-member when labelled/global', () => {
    const m = model()
    placeSymbol(m, { refdes: 'C1', value: '100nF', kind: 'sym2' }, {})
    placePowerSymbol(m, { name: 'GND', endpoint: 'C1.2' })
    const warnings = runChecks(m.file)
    expect(warnings.filter((w) => w.code === 'single_member_net')).toHaveLength(0)
    // The power symbol pin is a member of the GND net → no unconnected flag for it.
    expect(warnings.filter((w) => w.code === 'unconnected_pin' && w.target.includes('#PWR'))).toHaveLength(0)
  })
})
