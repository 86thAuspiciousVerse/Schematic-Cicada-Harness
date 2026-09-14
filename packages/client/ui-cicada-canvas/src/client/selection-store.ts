/**
 * Canvas selection mirror store: the latest `cicada/editor/selection` payload
 * forwarded by the Remote whitelist. State is a plain display snapshot; the
 * apply-layer `$on` subscription is the only writer. Module level exports the
 * factory only — a module-level handle would pin the store's identity.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SelectionItem } from '@deepseek-ai/dsh-cicada-editor-bridge/types'

/** One mirrored selection state. */
export interface CanvasSelection {
  /** The session that received the injection. */
  sessionId: string
  /** The selected items, in canvas order. */
  selection: SelectionItem[]
}

type CanvasSelectionState = { current: CanvasSelection | undefined }

type CanvasSelectionActions = {
  setSelection: (draft: CanvasSelectionState, value: CanvasSelection) => void
}

/**
 * Create the canvas selection mirror store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createSelectionStore(): EngineStoreHandle<CanvasSelectionState, CanvasSelectionActions> {
  const handle = defineStore({
    init: (): CanvasSelectionState => ({ current: undefined }),
    actions: {
      setSelection: (d, value: CanvasSelection) => { d.current = value },
    },
  })
  return handle
}
