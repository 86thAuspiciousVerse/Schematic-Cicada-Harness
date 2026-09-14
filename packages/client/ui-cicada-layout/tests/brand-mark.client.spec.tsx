// @vitest-environment jsdom
/**
 * Sidebar brand components (docs/04 §4): the product mark/name replace the
 * shell's DSH whale + "DSH 本地构建" + version chip in the sidebar slots.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CicadaBrandMark, CicadaBrandName } from '../src/client/Brand.tsx'
import { BRAND_MARK_PATH, PRODUCT_TITLE } from '../src/client/brand.ts'

describe('CicadaBrandMark', () => {
  afterEach(() => { cleanup() })

  it('renders the product glyph at the requested size', () => {
    render(<CicadaBrandMark size={24} /> as never)
    const image = document.querySelector('[data-cicada-brand-mark]')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toBe(BRAND_MARK_PATH)
    expect(image?.getAttribute('width')).toBe('24')
    expect(image?.getAttribute('alt')).toBe('')
  })

  it('defaults to 24 when the slot passes no size', () => {
    render(<CicadaBrandMark /> as never)
    expect(document.querySelector('[data-cicada-brand-mark]')?.getAttribute('width')).toBe('24')
  })
})

describe('CicadaBrandName', () => {
  afterEach(() => { cleanup() })

  it('shows the product title without the shell version chip', () => {
    render(<CicadaBrandName /> as never)
    expect(document.querySelector('[data-cicada-brand-name]')?.textContent).toBe(PRODUCT_TITLE)
  })
})
