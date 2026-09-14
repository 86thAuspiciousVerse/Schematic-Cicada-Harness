// @vitest-environment jsdom
/**
 * Product branding (docs/04 §4): the cicada frame owns the window title and the
 * favicon, because an Edge `--app` window takes both from the page — the shell's
 * default ("DSH Local Build" + the DSH favicon) must not leak into the product.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { applyBrand, BRAND_ICON_PATH, PRODUCT_TITLE } from '../src/client/brand.ts'

describe('applyBrand', () => {
  afterEach(() => {
    document.title = ''
    document.head.querySelectorAll('link[rel="icon"]').forEach(link => { link.remove() })
  })

  it('sets the product title and points the favicon at the host brand route', () => {
    const dispose = applyBrand()
    expect(document.title).toBe(PRODUCT_TITLE)
    const link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')
    expect(link?.getAttribute('href')).toBe(BRAND_ICON_PATH)
    expect(link?.type).toBe('image/png')
    dispose()
    expect(document.head.querySelector('link[rel="icon"]')).toBeNull()
  })

  it('replaces an existing favicon and restores it on dispose', () => {
    const existing = document.createElement('link')
    existing.rel = 'icon'
    existing.href = '/favicon.svg'
    document.head.appendChild(existing)

    const dispose = applyBrand()
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
    expect(existing.getAttribute('href')).toBe(BRAND_ICON_PATH)
    dispose()
    expect(existing.getAttribute('href')).toBe('/favicon.svg')
  })
})
