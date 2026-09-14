// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {} from '../src/client/index.ts' // activates the LocaleNamespaceMap merge
import { createPipelineStore } from '../src/client/pipeline-store.ts'
import { deriveCards, PIPELINE_CARD_CAP } from '../src/client/derive-cards.ts'
import { PipelineCardList } from '../src/client/views/PipelineCardList.tsx'
import { zh } from '../src/client/locales.ts'

type Props = Parameters<typeof PipelineCardList>[0]

const t: Props['t'] = makeTranslate(zh, commonZh)

function windowWith(entries: unknown[]): never {
  return { entries } as never
}

describe('deriveCards', () => {
  it('derives one card per tool/call and folds tool/result status', () => {
    const window = windowWith([
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'place_symbol', turn: 1, step: 1 } } },
      { type: 'event', event: { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } } },
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c2', name: 'connect_pins', turn: 1, step: 2 } } },
    ])
    const cards = deriveCards(window)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({ callId: 'c1', tool: 'place_symbol', status: 'ok' })
    expect(cards[1]).toMatchObject({ callId: 'c2', tool: 'connect_pins', status: 'running' })
  })

  it('marks result errors as error', () => {
    const window = windowWith([
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'place_symbol', turn: 1, step: 1 } } },
      { type: 'event', event: { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] } }, error: { name: 'X', code: 'symbol_unsupported' } } },
    ])
    const cards = deriveCards(window)
    expect(cards[0]?.status).toBe('error')
  })

  it('skips non-event and non-tool entries', () => {
    const window = windowWith([
      { type: 'chunks', event: {} },
      { type: 'event', event: { type: 'user/message', data: {} } },
    ])
    expect(deriveCards(window)).toHaveLength(0)
  })

  it('caps the card list', () => {
    const entries = Array.from({ length: PIPELINE_CARD_CAP + 5 }, (_, i) => ({
      type: 'event',
      event: { type: 'tool/call', data: { callId: `c${i}`, name: 'x', turn: 1, step: i } },
    }))
    expect(deriveCards(windowWith(entries))).toHaveLength(PIPELINE_CARD_CAP)
  })
})

describe('PipelineCardList', () => {
  beforeEach(() => { cleanup() })
  afterEach(() => { cleanup() })

  it('renders the empty state copy when there are no cards', () => {
    const store = createPipelineStore()
    const instance = store.create()
    const props: Props = {
      useStore: (selector) => selector(instance.getSnapshot()),
      actions: instance.actions,
      t,
    }
    render(<PipelineCardList {...props} />)
    expect(screen.getByText(zh['panel.empty'])).toBeTruthy()
  })

  it('renders one row per card with tool name and status copy', () => {
    const store = createPipelineStore()
    const instance = store.create()
    instance.actions.setCards([
      { callId: 'c1', tool: 'place_symbol', turn: 1, step: 1, status: 'ok' },
      { callId: 'c2', tool: 'connect_pins', turn: 1, step: 2, status: 'running' },
    ])
    const props: Props = {
      useStore: (selector) => selector(instance.getSnapshot()),
      actions: instance.actions,
      t,
    }
    render(<PipelineCardList {...props} />)
    expect(screen.getByText('place_symbol')).toBeTruthy()
    expect(screen.getByText('connect_pins')).toBeTruthy()
  })
})
