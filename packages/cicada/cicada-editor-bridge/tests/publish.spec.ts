import { describe, expect, it, vi } from 'vitest'

import { publishRuntimeChange } from '../src/index.ts'
import type { RuntimeChangeEvent } from '../src/types.ts'

describe('publishRuntimeChange', () => {
  it('publishes ordered changelog, baseline, and canvas refresh frames', () => {
    const broadcast = vi.fn()
    const change: RuntimeChangeEvent = {
      workspace: 'workspace',
      file: 'schematic.cicada_sch',
      origin: 'watcher',
      baselineVersion: 'v2',
      baselineHash: 'a'.repeat(64),
      entries: [
        { seq: 4, type: 'user_edit', tool: 'watcher', summary: 'R1 值 10k → 4.7k', at: 1 },
        { seq: 5, type: 'datasheet_update', tool: 'knowledge', summary: 'ignored', at: 2 },
        { seq: 6, type: 'ai_op', tool: 'turn', summary: '新增 C1 (100nF)', at: 3 },
      ],
    }

    publishRuntimeChange({ broadcast, dispose: vi.fn() }, change)

    expect(broadcast.mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'changelog', seq: 4, kind: 'user_edit', summary: 'R1 值 10k → 4.7k', baselineHash: 'a'.repeat(64) },
      { type: 'changelog', seq: 6, kind: 'ai_op', summary: '新增 C1 (100nF)', baselineHash: 'a'.repeat(64) },
      { type: 'baseline', file: 'schematic.cicada_sch', baselineHash: 'a'.repeat(64) },
      { type: 'canvas.refresh', file: 'schematic.cicada_sch', reason: 'watcher' },
    ])
  })

  it('does nothing when the bridge is unavailable', () => {
    expect(() => publishRuntimeChange(undefined, {
      workspace: 'workspace', file: 'schematic.cicada_sch', origin: 'baseline', baselineVersion: 'v1', baselineHash: 'b'.repeat(64), entries: [],
    })).not.toThrow()
  })
})
