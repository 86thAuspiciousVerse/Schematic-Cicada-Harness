import { describe, expect, it } from 'vitest'

import {
  EDITOR_HTTP,
  EDITOR_PATH_PREFIX,
  SELECTION_PATH,
  STATE_PATH,
  WS_PATH,
  isSelectionItem,
  isSelectionRequest,
  type EditorDownlink,
} from '../src/contract.ts'

/** Every v1-declared downlink frame, with its exact key set (P6 定案 G-P6-4). */
const FRAMES: Array<{ name: string; frame: EditorDownlink; keys: string[] }> = [
  { name: 'hello', frame: { type: 'hello', port: 3123 }, keys: ['type', 'port'] },
  { name: 'hello+sessionKey', frame: { type: 'hello', port: 3123, sessionKey: 'k' }, keys: ['type', 'port', 'sessionKey'] },
  { name: 'canvas.refresh', frame: { type: 'canvas.refresh', file: 'schematic.cicada_sch', reason: 'ai-write' }, keys: ['type', 'file', 'reason'] },
  { name: 'changelog', frame: { type: 'changelog', seq: 1, kind: 'ai_op', summary: 's', baselineHash: 'h' }, keys: ['type', 'seq', 'kind', 'summary', 'baselineHash'] },
  { name: 'baseline', frame: { type: 'baseline', file: 'f', baselineHash: 'h' }, keys: ['type', 'file', 'baselineHash'] },
  { name: 'datasheet.update', frame: { type: 'datasheet.update', partNumber: 'p', groupId: 'g', owner: 'o' }, keys: ['type', 'partNumber', 'groupId', 'owner'] },
  { name: 'selection.confirm', frame: { type: 'selection.confirm', sessionId: 's', selection: [{ kind: 'symbol', refdes: 'R1' }] }, keys: ['type', 'sessionId', 'selection'] },
  { name: 'ping', frame: { type: 'ping', t: 123 }, keys: ['type', 't'] },
]

describe('contract endpoints', () => {
  it('ws path is under the editor prefix (the prefix route owns its non-upgrade GET)', () => {
    expect(WS_PATH.startsWith(`${EDITOR_PATH_PREFIX}/`)).toBe(true)
  })

  it('selection and state paths are under the prefix', () => {
    expect(SELECTION_PATH.startsWith(`${EDITOR_PATH_PREFIX}/`)).toBe(true)
    expect(STATE_PATH.startsWith(`${EDITOR_PATH_PREFIX}/`)).toBe(true)
  })

  it('declares the seven-frame downlink union with exact key sets', () => {
    for (const { name, frame, keys } of FRAMES) {
      expect(Object.keys(frame).sort(), name).toEqual([...keys].sort())
    }
    expect(new Set(FRAMES.map(entry => entry.frame.type)).size).toBe(7)
  })

  it('the hello sessionKey variant is optional', () => {
    expect(Object.keys({ type: 'hello', port: 1, sessionKey: 'k' }).sort()).toEqual(['port', 'sessionKey', 'type'])
  })

  it('exposes the fixed error code table', () => {
    expect(EDITOR_HTTP.FORBIDDEN).toBe(403)
    expect(EDITOR_HTTP.UNAUTHORIZED).toBe(401)
    expect(EDITOR_HTTP.UPGRADE_REQUIRED).toBe(426)
  })
})

describe('isSelectionItem', () => {
  it('accepts a minimal symbol item', () => {
    expect(isSelectionItem({ kind: 'symbol', refdes: 'R1' })).toBe(true)
  })

  it('accepts every kind with all optional fields', () => {
    expect(isSelectionItem({ kind: 'wire', uuid: 'u', pins: ['1', '2'], net: ['NET1'] })).toBe(true)
    expect(isSelectionItem({ kind: 'label', value: 'GND' })).toBe(true)
    expect(isSelectionItem({ kind: 'no_connect', uuid: 'u' })).toBe(true)
  })

  it('rejects unknown kind and malformed optional fields', () => {
    expect(isSelectionItem({ kind: 'resistor' })).toBe(false)
    expect(isSelectionItem({ kind: 'symbol', refdes: 5 })).toBe(false)
    expect(isSelectionItem({ kind: 'symbol', pins: [1] })).toBe(false)
    expect(isSelectionItem({ kind: 'symbol', net: 'NET1' })).toBe(false)
    expect(isSelectionItem(null)).toBe(false)
    expect(isSelectionItem('symbol')).toBe(false)
  })
})

describe('isSelectionRequest', () => {
  it('accepts a selection array with optional sessionId', () => {
    expect(isSelectionRequest({ selection: [{ kind: 'symbol' }], sessionId: 's' })).toBe(true)
    expect(isSelectionRequest({ selection: [] })).toBe(true)
  })

  it('rejects non-array selection and malformed items', () => {
    expect(isSelectionRequest({ selection: 'R1' })).toBe(false)
    expect(isSelectionRequest({ selection: [{ kind: 'bogus' }] })).toBe(false)
    expect(isSelectionRequest({ selection: [{ kind: 'symbol' }], sessionId: 7 })).toBe(false)
    expect(isSelectionRequest({})).toBe(false)
  })
})
