/**
 * Cicada pipeline plugin, browser half: contributes one card-flow entry into
 * the cicada.pipeline slot (declared by ui-cicada-layout). The card flow is
 * derived from the current session's event window (SessionBinding.eventSource
 * — zero new remote events, 9-impl §1.13): an apply-layer subscription follows
 * the sessions list, binds the current session's event source, and folds
 * tool/call + tool/result entries into the pipeline store. The store actions
 * are captured from the entry's inject face (same wiring pattern as
 * ui-layout's attachPanels); components never subscribe themselves.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-cicada-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { PipelineCard } from './pipeline-store.ts'
import { createPipelineStore } from './pipeline-store.ts'
import { deriveCards } from './derive-cards.ts'
import { PipelineCardList } from './views/PipelineCardList.tsx'
import { en, zh, type CicadaPipelineKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'cicada.pipeline': CicadaPipelineKey
  }
}

const NS = 'cicada.pipeline'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Client plugin body: register the pipeline card list into the
 * cicada.pipeline slot and subscribe the session event window into its store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const store = createPipelineStore()

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cicada-pipeline: dictionaries')

  // Store write face captured from the entry inject (per current session);
  // pending cards bridge the window between event arrival and first render.
  let write: ((cards: PipelineCard[]) => void) | undefined
  let pending: PipelineCard[] | undefined

  ctx.slots.inject('cicada.pipeline', () => ctx.slots.register({
    name: 'cicada.pipeline',
    id: 'cicada-pipeline',
    order: 10,
    locale: NS,
    store,
    inject: (_sessionId: string, actions: BoundActions<ReturnType<typeof createPipelineStore>>): object => {
      // The framework passes BoundActions of the per-session store instance.
      const bound = actions as unknown as { setCards: (cards: PipelineCard[]) => void }
      write = (cards) => { bound.setCards(cards) }
      if (pending !== undefined) {
        write(pending)
        pending = undefined
      }
      return {}
    },
  }, PipelineCardList))

  // Object-layer subscription: follow the sessions list, bind the current
  // session's event source, fold the window into cards. One effect owns the
  // whole chain so fiber teardown removes every subscription.
  ctx.effect(() => {
    let offFeed: (() => void) | undefined
    const bind = (): void => {
      offFeed?.()
      offFeed = undefined
      const current = ctx.sessions.list.getSnapshot().current
      if (current === undefined) return
      const binding = ctx.sessions.binding(current)
      if (binding === undefined) return
      const fold = (): void => {
        const cards = deriveCards(binding.eventSource.getSnapshot())
        if (write === undefined) pending = cards
        else write(cards)
      }
      offFeed = binding.eventSource.subscribe(fold)
      fold()
    }
    const offList = ctx.sessions.list.subscribe(bind)
    bind()
    return () => {
      offList()
      offFeed?.()
    }
  }, 'ui-cicada-pipeline: event feed')
}
