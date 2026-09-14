/**
 * Pipeline card list: pure presentation of the derived tool-call cards.
 * Everything arrives through the framework shares — store state via useStore,
 * copy via t. No subscriptions (the apply-layer feed owns them).
 */
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createPipelineStore } from '../pipeline-store.ts'
import css from './PipelineCardList.module.css'

/** Composed props: store share (cards) + locale share (t). */
export type PipelineCardListProps =
  & PropsStore<ReturnType<typeof createPipelineStore>>
  & PropsLocale<'cicada.pipeline'>

/** Status → locale key for the status pill. */
const STATUS_KEY = {
  running: 'status.running',
  ok: 'status.ok',
  error: 'status.error',
} as const

/** The pipeline card list (see module doc). */
export function PipelineCardList({ useStore, t }: PipelineCardListProps) {
  const cards = useStore(s => s.cards)
  if (cards.length === 0) {
    return <div className={css.empty}>{t('panel.empty')}</div>
  }
  return (
    <ul className={css.list}>
      {cards.map((card) => (
        <li key={card.callId} className={css.card} data-status={card.status} aria-label={t('card.aria', { tool: card.tool })}>
          <span className={css.tool}>{card.tool}</span>
          <span className={css.status}>{t(STATUS_KEY[card.status])}</span>
        </li>
      ))}
    </ul>
  )
}
