import { describe, expect, it } from 'vitest'

import { diffComponents, type ChangelogView } from '../src/changelog.ts'

const view = (nets: ChangelogView['nets']): ChangelogView => ({
  components: [{ refdes: 'R1', value: '10k' }],
  nets,
})

describe('diffComponents net semantics', () => {
  it('ignores member ordering changes', () => {
    expect(diffComponents(
      view([{ name: 'NET1', members: ['R1.1', 'C1.2'] }]),
      view([{ name: 'NET1', members: ['C1.2', 'R1.1'] }]),
    )).toEqual([])
  })

  it('reports changed, added, and removed networks', () => {
    expect(diffComponents(
      view([{ name: 'OLD', members: ['R1.1'] }, { name: 'CHANGED', members: ['R1.2'] }]),
      view([{ name: 'CHANGED', members: ['R1.2', 'C1.1'] }, { name: 'NEW', members: ['C1.2'] }]),
    )).toEqual([
      '网络 CHANGED 更新 (C1.1, R1.2)',
      '网络 NEW 更新 (C1.2)',
      '网络 OLD 更新（已移除）',
    ])
  })
})
