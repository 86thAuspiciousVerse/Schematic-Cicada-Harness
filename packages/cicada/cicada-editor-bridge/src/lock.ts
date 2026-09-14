/**
 * Editor mutual-exclusion lock (docs/05 §1): the host-side state machine that
 * keeps the canvas and the AI write tools from touching the schematic at the
 * same time.
 *
 * `lock.ts` is deliberately POLICY-FREE: it knows owners (`agent` / `human`),
 * leases, refcounts, and mode transitions — not *when* an agent counts as
 * editing. The runtime decides that (it calls `acquireAgent` at a turn's first
 * step and `releaseAgent` after the turn's commit), so the semantics can be
 * refined without touching this module.
 *
 * Modes: `idle` → `agent-editing` (one or more nested agent turns) → `idle`;
 * `idle` → `human-editing` (one canvas gesture lease) → `idle`. An agent turn
 * starting while a human lease is held PREEMPTS it (the user just sent a
 * message, so they are done editing).
 */

/** Who currently owns the schematic. */
export type LockMode = 'idle' | 'agent-editing' | 'human-editing'

/** One immutable lock view (plain JSON: crosses the WS wire). */
export interface LockSnapshot {
  mode: LockMode
  /** Nested agent turns holding the lock (0 = none). */
  agents: number
  /** Whether a human canvas lease is held. */
  human: boolean
}

/** Result of one human acquire attempt. */
export interface LockAcquireResult {
  ok: boolean
  snapshot: LockSnapshot
}

/** The lock authority exposed to the host as the `cicadaEditorLock` service. */
export interface EditorLock {
  /** Current immutable view. */
  snapshot(): LockSnapshot
  /** Enter one agent turn (refcounted). Preempts a held human lease. */
  acquireAgent(): LockSnapshot
  /** Leave one agent turn (refcount floored at 0). */
  releaseAgent(): LockSnapshot
  /** Take the human gesture lease; refused while an agent turn holds the lock. */
  acquireHuman(): LockAcquireResult
  /** Drop the human gesture lease (idempotent). */
  releaseHuman(): LockSnapshot
  /** Refresh the human lease timers (idempotent; used by repeated enter-edit). */
  touchHuman(): LockSnapshot
  /** Whether an agent write tool may proceed now. */
  canAgentWrite(): boolean
  /** Stop all timers (plugin disposal). */
  dispose(): void
}

/** Lease timings (docs/05 §1). */
export const HUMAN_IDLE_MS = 5_000
export const HUMAN_MAX_MS = 60_000
export const AGENT_MAX_MS = 600_000

export interface LockManagerOptions {
  /** Called on every mode CHANGE (never for same-mode snapshots). */
  onMode: (snapshot: LockSnapshot) => void
  humanIdleMs?: number
  humanMaxMs?: number
  agentMaxMs?: number
}

/** Create the host's single editor lock. */
export function createEditorLock(options: LockManagerOptions): EditorLock {
  const humanIdleMs = options.humanIdleMs ?? HUMAN_IDLE_MS
  const humanMaxMs = options.humanMaxMs ?? HUMAN_MAX_MS
  const agentMaxMs = options.agentMaxMs ?? AGENT_MAX_MS

  let agents = 0
  let human = false
  let lastMode: LockMode = 'idle'
  let humanIdleTimer: ReturnType<typeof setTimeout> | undefined
  let humanMaxTimer: ReturnType<typeof setTimeout> | undefined
  let agentTimer: ReturnType<typeof setTimeout> | undefined

  const modeOf = (): LockMode => (human ? 'human-editing' : agents > 0 ? 'agent-editing' : 'idle')
  const snapshot = (): LockSnapshot => ({ mode: modeOf(), agents, human })

  const publish = (): LockSnapshot => {
    const snap = snapshot()
    if (snap.mode !== lastMode) {
      lastMode = snap.mode
      options.onMode(snap)
    }
    return snap
  }

  const clearHumanTimers = (): void => {
    if (humanIdleTimer !== undefined) clearTimeout(humanIdleTimer)
    if (humanMaxTimer !== undefined) clearTimeout(humanMaxTimer)
    humanIdleTimer = undefined
    humanMaxTimer = undefined
  }
  const clearAgentTimer = (): void => {
    if (agentTimer !== undefined) clearTimeout(agentTimer)
    agentTimer = undefined
  }
  const dropHuman = (): void => {
    clearHumanTimers()
    if (human) {
      human = false
      publish()
    }
  }

  /** Idle timer only: `touchHuman` extends the idle window, never the hard ceiling. */
  const armHumanIdle = (): void => {
    if (humanIdleTimer !== undefined) clearTimeout(humanIdleTimer)
    humanIdleTimer = setTimeout(() => { dropHuman() }, humanIdleMs)
  }

  const armHumanTimers = (): void => {
    clearHumanTimers()
    armHumanIdle()
    humanMaxTimer = setTimeout(() => { dropHuman() }, humanMaxMs)
  }

  const armAgentTimer = (): void => {
    clearAgentTimer()
    // Backstop only: a crashed/aborted turn must not wedge the canvas forever.
    agentTimer = setTimeout(() => {
      agents = 0
      clearAgentTimer()
      publish()
    }, agentMaxMs)
  }

  return {
    snapshot,
    acquireAgent(): LockSnapshot {
      // Preempt a human lease WITHOUT publishing the transient idle: the canvas
      // must go straight to agent-editing (no overlay flicker).
      clearHumanTimers()
      human = false
      agents += 1
      armAgentTimer()
      return publish()
    },
    releaseAgent(): LockSnapshot {
      agents = Math.max(0, agents - 1)
      if (agents === 0) clearAgentTimer()
      return publish()
    },
    acquireHuman(): LockAcquireResult {
      if (agents > 0) return { ok: false, snapshot: snapshot() }
      human = true
      armHumanTimers()
      return { ok: true, snapshot: publish() }
    },
    releaseHuman(): LockSnapshot {
      dropHuman()
      return snapshot()
    },
    touchHuman(): LockSnapshot {
      if (!human) return snapshot()
      armHumanIdle()
      return snapshot()
    },
    canAgentWrite(): boolean {
      return !human
    },
    dispose(): void {
      clearHumanTimers()
      clearAgentTimer()
    },
  }
}
