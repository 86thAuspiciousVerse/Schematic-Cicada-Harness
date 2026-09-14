/**
 * Client-safe type surface of the editor-bridge seam: the forwarded
 * `cicada/editor/selection` event declaration and the selection payload
 * vocabulary. Types only — no runtime code, nothing Host-only, so both the
 * Host `api/remotes` face (satisfies assertion) and the client
 * `ctx.remote.$on` face read the very signature the bridge emits.
 *
 * @module @deepseek-ai/dsh-cicada-editor-bridge/types
 */

import type { SelectionItem } from './contract.ts'

export interface RuntimeChangeEvent {
  workspace: string
  file: string
  origin: 'ai-write' | 'watcher' | 'baseline'
  baselineVersion: string
  baselineHash: string
  entries: { seq?: number; type: 'ai_op' | 'user_edit' | 'datasheet_update'; summary: string; tool: string; at: number }[]
}

/**
 * Host event forwarded to the webui canvas mirror through the Remote
 * whitelist (`api/remotes/src/remote-events.ts`, mode `emit`). Unscoped void
 * event: no `this` parameter and a `void` result, so the Typert shape
 * assertion accepts the `emit` mode.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One canvas selection was accepted and injected into the main agent
     * session. Payload is lossless JSON (whitelist `assertJsonArgs`).
     * @param payload - the injected selection and its target session.
     */
    'cicada/editor/selection'(payload: { sessionId: string; selection: SelectionItem[] }): void
    /** Runtime publication after schematic sidecars commit. */
    'cicada/runtime/changed'(payload: RuntimeChangeEvent): void
  }
}

export type { SelectionItem }
export type { EditorDownlink, SelectionRequest, SelectionResponse, EditorState } from './contract.ts'
