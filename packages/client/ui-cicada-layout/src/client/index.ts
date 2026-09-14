/**
 * Cicada layout plugin, browser half: one register() call contributes
 * CicadaAppFrame into the runtime's built-in 'root' slot and, in the same
 * breath, re-declares the four native child slots (sidebar / conversation /
 * details / shell.overlay — same kind/scope as the native ui-layout so its
 * occupants keep rendering) plus the two cicada slots (cicada.pipeline /
 * cicada.canvas). Seats the layout store (panel geometry) and wires the
 * panel-action service face under the same `ctx.layout` contract the native
 * layout exposed, so existing consumers (ui-sidebar, ui-chat) keep working.
 * A second effect seats the theme presenter, which projects ctx.theme
 * snapshots onto document.body (same behavior as the native layout).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {
  ConvOwnerProps, DetailsOwnerProps, SidebarOwnerProps,
} from '@deepseek-ai/dsh-client-ui-layout/client'
import { CicadaAppFrame } from './AppFrame.tsx'
import { CicadaBrandMark, CicadaBrandName } from './Brand.tsx'
import { applyBrand } from './brand.ts'
import { WorkspaceSelect } from './WorkspaceSelect.tsx'
import { createCicadaLayoutStore } from './stores.ts'
import { CicadaLayoutController, type CicadaPanelActions } from './service.ts'
import { CicadaThemePresenter } from './theme-presenter.ts'
import { en, zh, type CicadaLayoutKey } from './locales.ts'

// Contract exports only (export-convergence rule): the ctx.layout face
// consumers and test fakes type against.
export { CicadaLayoutController } from './service.ts'
export type { ICicadaLayout } from './service.ts'

// NOTE: `ctx.layout`'s type is intentionally NOT re-declared here — the
// native ui-layout package already merges `interface Context { layout: ILayout }`
// and is a type dependency of this package (re-declaring the same property
// with a sibling interface would fail declaration merging). The cicada
// controller implements the same structural face (toggleSidebar /
// openDetails / closeDetails), so runtime consumers are unaffected.

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The four native child slots, re-declared with the exact kind/scope the
    // native ui-layout declared (ui-slots/src/index.ts:1127-1146: an entry
    // removal clears every child slot it declared; the cicada frame must own
    // the same declarations or the native occupants disappear).
    /** The whole left column. OCCUPIED by ui-sidebar's SidebarRoot. */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /** The whole center column. OCCUPIED by ui-conversation's ConversationRoot. */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /** The right details column, shown when the layout opens it. */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /** Frame-wide floating layer, above every column (click-through). */
    'shell.overlay': { kind: 'list'; scope: 'root' }
    /**
     * The cicada pipeline sidebar (fixed column between conversation and
     * details). list/session: one card entry per pipeline stage/turn.
     */
    'cicada.pipeline': { kind: 'list'; scope: 'session' }
    /**
     * The cicada canvas mirror (selection state; v1 placeholder). single:
     * one mirror surface per session.
     */
    'cicada.canvas': { kind: 'single'; scope: 'session' }
  }
  interface LocaleNamespaceMap {
    'cicada.layout': CicadaLayoutKey
  }
}

const NS = 'cicada.layout'

/**
 * Adopt the project the launcher window started this stack for.
 *
 * The launcher passes it as `CICADA_INITIAL_WORKSPACE`; the editor bridge hands
 * it out once through `GET /cicada/editor/initial-workspace` (same-origin, like
 * the other page routes). Registering is idempotent by path and
 * `uiWorkspace.startSession` applies DSH's own "open a session in this
 * workspace" policy, so this adds no new mechanism.
 * @param ctx - client root context.
 */
export async function adoptInitialWorkspace(ctx: ClientContext): Promise<void> {
  try {
    const response = await fetch('/cicada/editor/initial-workspace', { headers: { accept: 'application/json' } })
    if (!response.ok) return
    const body = (await response.json()) as { path?: unknown }
    const path = typeof body.path === 'string' ? body.path : ''
    if (path === '') return
    const workspaces = ctx.get('workspaces') as
      { create?: (input: { path: string }) => Promise<{ workspaceId: string }> } | undefined
    const nav = ctx.get('uiWorkspace') as { startSession?: (id?: string) => void } | undefined
    if (workspaces?.create === undefined) return
    const workspace = await workspaces.create({ path })
    nav?.startSession?.(workspace.workspaceId)
  } catch {
    // Adoption is a convenience: an unreachable bridge or a refused path must
    // never break the client (the workspace picker still works by hand).
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'theme', 'locale']

/**
 * Client plugin body: provide ctx.layout, then one register() call —
 * CicadaAppFrame into 'root' with the six child-slot declarations, the layout
 * store seat, and the inject hook that hands the store's bound actions to the
 * service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new CicadaLayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: NS,
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'cicada.pipeline': { kind: 'list', scope: 'session' },
        'cicada.canvas': { kind: 'single', scope: 'session' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to CicadaAppFrame as standard props.
      store: createCicadaLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout.
      inject: (actions: CicadaPanelActions) => {
        layout.attachPanels(actions)
        return {}
      },
    }, CicadaAppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-cicada-layout: service + root registration')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cicada-layout: dictionaries')

  // 产品品牌（docs/04 §4）：窗口标题 + 任务栏/标签图标（Edge --app 窗口取自页面）。
  ctx.effect(() => applyBrand(), 'ui-cicada-layout: product title + favicon')

  // 启动器带项目启动（docs/04 §5.2）：桥把 CICADA_INITIAL_WORKSPACE 一次性交给
  // 第一个读者——注册该目录并直接在其中开会话（connectWorkspace 会复用该工作区
  // 已存在的空白会话，不会越积越多）。刷新页面拿不到第二次，故不会重复开。
  // 等 `workspaces`/`uiWorkspace` 就绪再执行：client 插件注册顺序不保证。
  ctx.inject(['workspaces', 'uiWorkspace'], (scope: ClientContext) => {
    scope.effect(() => { void adoptInitialWorkspace(scope) }, 'ui-cicada-layout: launcher project')
  })

  // K6 chat 单列模式：工作区选择器挂在对话输入条左侧（PermissionSelect 旁）。
  // 等待键 = 'conversation.input.left' 自身的声明（ConversationRoot 的 children 表），
  // 不是 'conversation'（后者被我们 root 声明过早触发——实测 K6：错等键 → HARNESS
  // "slot is not declared" 整包崩溃）。
  // 切换动作经 register 的 inject 工厂注入（运行时；组件侧以 WorkspaceSwitch 断言接收）：
  // 复用 DSH 的 client 服务（uiWorkspace.connectWorkspace + sessions.open，同 ui-conversation）
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    locale: NS,
    inject: (): object => {
      const nav = ctx.get('uiWorkspace') as
        { connectWorkspace?: (id: string) => Promise<string> } | undefined
      return {
        switchWorkspace: async (workspaceId: string): Promise<void> => {
          if (nav?.connectWorkspace === undefined) return
          const nextId = await nav.connectWorkspace(workspaceId)
          await ctx.sessions.open(nextId)
        },
      }
    },
  }, WorkspaceSelect))


  // 产品品牌槽位（docs/04 §4）：替换 ui-sidebar 的 DSH 鲸鱼 + "DSH 本地构建" + 版本号。
  // 槽由 ui-sidebar 声明（root/single），等待键 = 槽名本身。
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark',
    locale: NS,
  }, CicadaBrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name',
    locale: NS,
  }, CicadaBrandName))


  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new CicadaThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-cicada-layout: theme presenter')
}
