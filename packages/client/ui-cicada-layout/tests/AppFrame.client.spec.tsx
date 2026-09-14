// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {} from '../src/client/index.ts' // activates the SlotMap + LocaleNamespaceMap merges
import { createCicadaLayoutStore } from '../src/client/stores.ts'
import { CicadaAppFrame } from '../src/client/AppFrame.tsx'
import { zh } from '../src/client/locales.ts'

type Props = Parameters<typeof CicadaAppFrame>[0]

function makeProps(overrides: { sidebar?: number; details?: number } = {}): {
  props: Props
  calls: { slot: string; owner: Record<string, unknown> }[]
} {
  const store = createCicadaLayoutStore()
  const instance = store.create()
  instance.actions.setSidebar(overrides.sidebar ?? 280)
  if (overrides.details !== undefined) instance.actions.setDetails(overrides.details)
  const calls: { slot: string; owner: Record<string, unknown> }[] = []
  const props: Props = {
    useStore: (selector) => selector(instance.getSnapshot()),
    actions: instance.actions,
    useSessions: (() => undefined) as Props['useSessions'],
    useWorkspaces: (() => undefined) as Props['useWorkspaces'],
    useSessionPendingInteraction: (() => undefined) as Props['useSessionPendingInteraction'],
    SessionProvider: (({ children }) => children) as Props['SessionProvider'],
    renderSlot: ((slot: string, owner: Record<string, unknown>) => {
      calls.push({ slot, owner })
      return null
    }) as Props['renderSlot'],
    t: makeTranslate(zh, commonZh),
  }
  return { props, calls }
}

describe('CicadaAppFrame', () => {
  beforeEach(() => {
    cleanup()
    window.localStorage.clear()
  })
  afterEach(() => { cleanup() })

  it('renders the four native child slots and the two cicada slots', () => {
    const { props, calls } = makeProps()
    render(<CicadaAppFrame {...props} />)
    const slots = calls.map((call) => call.slot)
    for (const name of ['sidebar', 'conversation', 'details', 'shell.overlay', 'cicada.pipeline', 'cicada.canvas']) {
      expect(slots).toContain(name)
    }
  })

  it('passes live sidebar state to the sidebar slot', () => {
    const { props, calls } = makeProps({ sidebar: 280 })
    render(<CicadaAppFrame {...props} />)
    const sidebarCall = calls.find((call) => call.slot === 'sidebar')
    expect(sidebarCall?.owner).toMatchObject({ collapsed: false, width: 280 })
  })

  it('closes the sidebar to the collapsed rail width', () => {
    const { props, calls } = makeProps({ sidebar: 0 })
    render(<CicadaAppFrame {...props} />)
    const sidebarCall = calls.find((call) => call.slot === 'sidebar')
    expect(sidebarCall?.owner).toMatchObject({ collapsed: true, width: 56 })
  })

  it('drags the workspace sidebar handle and persists the width', () => {
    window.localStorage.setItem('cicada.layout', 'workspace')
    const { props, calls } = makeProps()
    render(<CicadaAppFrame {...props} />)
    const sidebarOwner = (): Record<string, unknown> | undefined =>
      calls.filter((call) => call.slot === 'sidebar').at(-1)?.owner
    expect(sidebarOwner()).toMatchObject({ collapsed: false, width: 240 })

    const handle = document.querySelector('[data-cicada-sidebar-handle]')
    expect(handle).not.toBeNull()
    fireEvent.pointerDown(handle!, { clientX: 240 })
    fireEvent.pointerMove(window, { clientX: 320 })
    fireEvent.pointerUp(window)

    expect(sidebarOwner()).toMatchObject({ collapsed: false, width: 320 })
    expect(window.localStorage.getItem('cicada.sidebarWidth')).toBe('320')
  })

  it('restores the persisted workspace sidebar width', () => {
    window.localStorage.setItem('cicada.layout', 'workspace')
    window.localStorage.setItem('cicada.sidebarWidth', '300')
    const { props, calls } = makeProps()
    render(<CicadaAppFrame {...props} />)
    const sidebarOwner = calls.filter((call) => call.slot === 'sidebar').at(-1)?.owner
    expect(sidebarOwner).toMatchObject({ collapsed: false, width: 300 })
  })
})
