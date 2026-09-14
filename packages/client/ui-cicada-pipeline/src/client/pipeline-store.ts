/**
 * Pipeline store: the card flow derived from the session event window.
 * State is a plain display list; the event-feed subscription (apply/object
 * layer) is the only writer. Module level exports the factory only — a
 * module-level handle would pin the store's identity in the module cache.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** One pipeline card: a tool call whose status follows its tool/result. */
export interface PipelineCard {
  /** Tool call id pairing call with result. */
  callId: string
  /** Tool name (from the event, not localized). */
  tool: string
  /** Turn/step provenance for ordering and grouping. */
  turn: number
  step: number
  /** Derived status; 'running' until a matching result arrives. */
  status: 'running' | 'ok' | 'error'
}

type PipelineState = { cards: PipelineCard[] }

type PipelineActions = {
  setCards: (draft: PipelineState, cards: PipelineCard[]) => void
}

/**
 * Create the pipeline store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createPipelineStore(): EngineStoreHandle<PipelineState, PipelineActions> {
  const handle = defineStore({
    init: (): PipelineState => ({ cards: [] }),
    actions: {
      setCards: (d, cards: PipelineCard[]) => { d.cards = cards },
    },
  })
  return handle
}
