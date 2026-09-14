/**
 * Product branding for the desktop shell (docs/04 §4): the window title and the
 * taskbar/favicon. An Edge `--app` window takes both from the page, so the
 * cicada frame owns them instead of the generic DSH shell.
 *
 * `DSH_CLIENT_TITLE` is a build-time value (client bundles bake
 * `process.env.DSH_CLIENT_*`); when it is absent the product name below is the
 * fallback, never the shell's "DSH Local Build".
 */

/** Window/taskbar title. */
export const PRODUCT_TITLE = process.env.DSH_CLIENT_TITLE ?? 'Schematic-Cicada'

/** Host-served brand icon route (editor-bridge reads CICADA_BRAND_ICON). */
export const BRAND_ICON_PATH = '/cicada/editor/brand/icon.png'

/** Host-served sidebar brand mark route (transparent line art). */
export const BRAND_MARK_PATH = '/cicada/editor/brand/mark.png'

/**
 * Apply the product title and favicon to the current document. Browser-only:
 * a no-op outside a DOM (the module is imported by the client half only, but
 * tests may import it in a node environment).
 * @returns a disposer restoring the previous title and icon href.
 */
export function applyBrand(): () => void {
  if (typeof document === 'undefined') return () => {}
  const previousTitle = document.title
  document.title = PRODUCT_TITLE
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  const previousHref = existing?.getAttribute('href') ?? undefined
  const link = existing ?? document.createElement('link')
  if (existing === null) {
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/png'
  link.href = BRAND_ICON_PATH
  return () => {
    document.title = previousTitle
    if (previousHref === undefined) link.remove()
    else link.setAttribute('href', previousHref)
  }
}
