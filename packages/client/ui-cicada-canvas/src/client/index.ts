/**
 * Cicada canvas plugin, browser half: contributes the real schematic surface
 * into the `cicada.canvas` slot (declared by ui-cicada-layout). M1c replaces
 * the P6 selection-mirror placeholder: the pane renders the engine /scene
 * snapshot (SVG, IU coords), owns the viewport, and drives the engine HTTP +
 * /cicada/editor/ws data channels through the canvas driver (inject face).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-cicada-layout/client'
import type { CanvasActions } from './canvas_store.ts'
import type { CanvasApi } from './canvas_driver.ts'
import { createCanvasDriver } from './canvas_driver.ts'
import { createCanvasStore } from './canvas_store.ts'
import { CanvasPane } from './views/CanvasPane.tsx'
import { en, zh, type CicadaCanvasKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'cicada.canvas': CicadaCanvasKey
  }
}

const NS = 'cicada.canvas'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the canvas pane into the cicada.canvas slot.
 * The register's store = canvas shared state; its inject factory creates the
 * driver (engine HTTP + editor WS downlink) and hands the CanvasApi to the
 * component as plain callbacks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cicada-canvas: dictionaries')

  ctx.slots.inject('cicada.canvas', () => ctx.slots.register({
    name: 'cicada.canvas',
    locale: NS,
    store: createCanvasStore,
    // 槽 scope='session' + 有 store：inject = (sessionId, actions)——单参会把
    // 字符串当 actions（K6 教训：画布 0 请求 + 空白的根因）。
    inject: (sessionId: string, actions: CanvasActions): { canvas: CanvasApi } => ({
      // Inject 的 sessionId = 当前选中会话（画布注入目标/工作区唯一真相文件的会话语义）。
      canvas: createCanvasDriver(actions, sessionId),
    }),
  }, CanvasPane))
}
