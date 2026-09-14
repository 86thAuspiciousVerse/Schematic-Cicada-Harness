// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {} from '../src/client/index.ts' // activates the LocaleNamespaceMap merge
import { CanvasMirror } from '../src/client/views/CanvasMirror.tsx'
import { zh } from '../src/client/locales.ts'
import type { CanvasSelection } from '../src/client/selection-store.ts'

type Props = Parameters<typeof CanvasMirror>[0]

const t: Props['t'] = makeTranslate(zh, commonZh)

function renderMirror(current: CanvasSelection | undefined) {
  const useStore = <T,>(select: (s: { current: CanvasSelection | undefined }) => T): T => select({ current })
  render(<CanvasMirror t={t} useStore={useStore} /> as never)
}

describe('CanvasMirror', () => {
  beforeEach(() => { cleanup() })
  afterEach(() => { cleanup() })

  it('renders the placeholder while no selection is mirrored', () => {
    renderMirror(undefined)
    expect(screen.getByText(zh['mirror.placeholder'])).toBeTruthy()
  })

  it('renders the selected item names once a selection is mirrored', () => {
    renderMirror({ sessionId: 's', selection: [
      { kind: 'symbol', refdes: 'R1' },
      { kind: 'wire', uuid: 'u-9' },
    ] })
    expect(screen.getByText(/已选中 2 个图元/)).toBeTruthy()
    expect(screen.getByText('R1')).toBeTruthy()
    expect(screen.getByText('u-9')).toBeTruthy()
  })
})
