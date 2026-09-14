/**
 * Card derivation from a session event window: scan for tool/call entries,
 * then fold tool/result entries onto their matching cards. Cards keep
 * window order (append order); the caller may cap the list.
 */
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PipelineCard } from './pipeline-store.ts'

/** Max cards rendered in the sidebar (v1 cap; older activity is dropped). */
export const PIPELINE_CARD_CAP = 20

/**
 * Derive pipeline cards from the event window.
 * @param window - current session event window snapshot.
 * @returns cards in window order, capped at PIPELINE_CARD_CAP.
 */
export function deriveCards(window: SessionEventWindow): PipelineCard[] {
  const byCallId = new Map<string, PipelineCard>()
  const order: string[] = []
  for (const entry of window.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'tool/call') {
      const card: PipelineCard = {
        callId: event.data.callId,
        tool: event.data.name,
        turn: event.data.turn,
        step: event.data.step,
        status: 'running',
      }
      byCallId.set(card.callId, card)
      order.push(card.callId)
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const card = byCallId.get(block.toolCallId)
      if (card !== undefined) {
        card.status = block.isError === true || event.data.error !== undefined ? 'error' : 'ok'
      }
    }
  }
  const cards = order
    .map((callId) => byCallId.get(callId))
    .filter((card): card is PipelineCard => card !== undefined)
  return cards.slice(-PIPELINE_CARD_CAP)
}
