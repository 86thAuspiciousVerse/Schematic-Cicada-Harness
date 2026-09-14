/**
 * Editor lock state machine (docs/05 §1): refcounted agent turns, a human
 * gesture lease with idle/hard expiry, and the preemption rule (a new agent
 * turn takes the lock even while a human lease is held — the user just sent a
 * message, so they are done editing).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorLock, type LockMode } from '../src/lock.ts'

describe('createEditorLock', () => {
  afterEach(() => { vi.useRealTimers() })

  it('starts idle and only reports mode changes', () => {
    const modes: LockMode[] = []
    const lock = createEditorLock({ onMode: snapshot => modes.push(snapshot.mode) })
    expect(lock.snapshot()).toEqual({ mode: 'idle', agents: 0, human: false })
    lock.releaseAgent()
    lock.releaseHuman()
    expect(modes).toEqual([])
    lock.dispose()
  })

  it('refcounts nested agent turns', () => {
    const modes: LockMode[] = []
    const lock = createEditorLock({ onMode: snapshot => modes.push(snapshot.mode) })
    lock.acquireAgent()
    lock.acquireAgent()
    expect(lock.snapshot()).toEqual({ mode: 'agent-editing', agents: 2, human: false })
    lock.releaseAgent()
    expect(lock.snapshot().mode).toBe('agent-editing')
    lock.releaseAgent()
    expect(lock.snapshot().mode).toBe('idle')
    expect(modes).toEqual(['agent-editing', 'idle'])
    lock.dispose()
  })

  it('refuses a human lease while an agent turn holds the lock', () => {
    const lock = createEditorLock({ onMode: () => {} })
    lock.acquireAgent()
    const result = lock.acquireHuman()
    expect(result.ok).toBe(false)
    expect(result.snapshot).toEqual({ mode: 'agent-editing', agents: 1, human: false })
    expect(lock.canAgentWrite()).toBe(true)
    lock.dispose()
  })

  it('blocks agent writes while a human lease is held, and refreshes the lease', () => {
    vi.useFakeTimers()
    const modes: LockMode[] = []
    const lock = createEditorLock({ onMode: snapshot => modes.push(snapshot.mode), humanIdleMs: 5_000 })
    expect(lock.acquireHuman().ok).toBe(true)
    expect(lock.canAgentWrite()).toBe(false)
    vi.advanceTimersByTime(4_000)
    lock.touchHuman()
    vi.advanceTimersByTime(4_000)
    expect(lock.snapshot().mode).toBe('human-editing')
    vi.advanceTimersByTime(1_500)
    expect(lock.snapshot().mode).toBe('idle')
    expect(lock.canAgentWrite()).toBe(true)
    expect(modes).toEqual(['human-editing', 'idle'])
    lock.dispose()
  })

  it('expires the human lease at the hard ceiling even while touched', () => {
    vi.useFakeTimers()
    const lock = createEditorLock({ onMode: () => {}, humanIdleMs: 5_000, humanMaxMs: 12_000 })
    lock.acquireHuman()
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(4_000)
      lock.touchHuman()
    }
    expect(lock.snapshot().mode).toBe('idle')
    lock.dispose()
  })

  it('a new agent turn preempts a held human lease', () => {
    const modes: LockMode[] = []
    const lock = createEditorLock({ onMode: snapshot => modes.push(snapshot.mode) })
    lock.acquireHuman()
    lock.acquireAgent()
    expect(lock.snapshot()).toEqual({ mode: 'agent-editing', agents: 1, human: false })
    expect(lock.canAgentWrite()).toBe(true)
    expect(modes).toEqual(['human-editing', 'agent-editing'])
    lock.dispose()
  })

  it('releases a wedged agent turn at the hard ceiling', () => {
    vi.useFakeTimers()
    const modes: LockMode[] = []
    const lock = createEditorLock({ onMode: snapshot => modes.push(snapshot.mode), agentMaxMs: 60_000 })
    lock.acquireAgent()
    vi.advanceTimersByTime(59_000)
    expect(lock.snapshot().mode).toBe('agent-editing')
    vi.advanceTimersByTime(2_000)
    expect(lock.snapshot().mode).toBe('idle')
    expect(modes).toEqual(['agent-editing', 'idle'])
    lock.dispose()
  })

  it('releaseHuman is idempotent and silent when idle', () => {
    const modes: LockMode[] = []
    const lock = createEditorLock({ onMode: snapshot => modes.push(snapshot.mode) })
    expect(lock.releaseHuman().mode).toBe('idle')
    lock.acquireHuman()
    expect(lock.releaseHuman().mode).toBe('idle')
    expect(lock.releaseHuman().mode).toBe('idle')
    expect(modes).toEqual(['human-editing', 'idle'])
    lock.dispose()
  })
})
