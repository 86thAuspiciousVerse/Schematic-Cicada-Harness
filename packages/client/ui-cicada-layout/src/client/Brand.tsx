/**
 * Sidebar brand components (docs/04 §4): the product mark and name that replace
 * the shell's DSH whale + "DSH 本地构建" + version chip. Registered into the
 * `sidebar.brand.mark` / `sidebar.brand.name` slots that ui-sidebar declares, so
 * the native sidebar keeps owning its layout and the product owns its identity.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BRAND_MARK_PATH, PRODUCT_TITLE } from './brand.ts'

/** The sidebar glyph (expanded brand row + collapsed rail both use this slot). */
export function CicadaBrandMark({ size }: PropsRuntime<'sidebar.brand.mark'>) {
  const side = size ?? 24
  return (
    <img
      src={BRAND_MARK_PATH}
      alt=""
      width={side}
      height={side}
      style={{ display: 'block', objectFit: 'contain' }}
      data-cicada-brand-mark
    />
  )
}

/** The product name beside the mark (no shell version chip). */
export function CicadaBrandName() {
  // The sidebar brand row is one 24px line: nowrap + ellipsis so a narrow
  // sidebar truncates cleanly instead of wrapping and clipping (2026-09-09 实测),
  // and the user can widen the sidebar (drag handle) to see the full name.
  return (
    <span
      data-cicada-brand-name
      style={{
        display: 'block',
        maxWidth: '100%',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 14,
        letterSpacing: '0.02em',
      }}
    >
      {PRODUCT_TITLE}
    </span>
  )
}
