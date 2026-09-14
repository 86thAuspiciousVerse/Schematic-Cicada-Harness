/**
 * Canvas mirror: mirrors the latest `cicada/editor/selection` payload (P6).
 * Pure presentation of the selection store — store state via useStore, copy
 * via t; no subscriptions (the apply-layer $on owns them).
 */
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createSelectionStore } from '../selection-store.ts'
import css from './CanvasMirror.module.css'

/** Composed props: store share (selection) + locale share (t). */
export type CanvasMirrorProps =
  & PropsStore<ReturnType<typeof createSelectionStore>>
  & PropsLocale<'cicada.canvas'>

/** The canvas mirror surface (see module doc). */
export function CanvasMirror({ useStore, t }: CanvasMirrorProps) {
  const current = useStore(s => s.current)
  if (current === undefined) {
    return (
      <div className={css.mirror} aria-label={t('mirror.aria')}>
        {t('mirror.placeholder')}
      </div>
    )
  }
  return (
    <div className={css.mirror} aria-label={t('mirror.aria')}>
      <div className={css.heading}>{t('mirror.selected', { count: String(current.selection.length) })}</div>
      <ul className={css.list}>
        {current.selection.map((item, index) => (
          <li key={`${item.uuid ?? item.kind}-${String(index)}`} className={css.item}>
            {item.refdes ?? item.uuid ?? item.kind}
          </li>
        ))}
      </ul>
    </div>
  )
}
