/**
 * Cicada four-column shell frame, registered into the built-in 'root' slot
 * (the web shell renders only 'root'). Re-declares the four native child
 * slots (sidebar | conversation | details | shell.overlay) with the same
 * kind/scope so the native occupants (ui-sidebar, ui-conversation, ui-chat)
 * keep rendering unchanged, and adds the cicada slots: cicada.pipeline (the
 * fixed pipeline sidebar, 4-spec §2 四区) and cicada.canvas (selection
 * mirror, v1 placeholder). Pure component: everything arrives through the
 * framework shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import { PIPELINE_DEFAULT, SIDEBAR_COLLAPSED } from './columns.ts'
import type { createCicadaLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type CicadaAppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay' | 'cicada.pipeline' | 'cicada.canvas'>
  & PropsStore<ReturnType<typeof createCicadaLayoutStore>>
  & PropsLocale<'cicada.layout'>

/** Workspace (M1c) splitter geometry: sidebar draggable, canvas draggable, conversation flexible. */
const WORKSPACE_SIDEBAR_PX = 240
const WORKSPACE_SIDEBAR_MIN_PX = 160
const WORKSPACE_SIDEBAR_MAX_PX = 520
const WORKSPACE_CANVAS_MIN_PX = 240
const WORKSPACE_CONVERSATION_MIN_PX = 320
const CANVAS_WIDTH_KEY = 'cicada.canvasWidth'
const SIDEBAR_WIDTH_KEY = 'cicada.sidebarWidth'

const clampSidebarWidth = (w: number): number => {
  const max = Math.max(
    WORKSPACE_SIDEBAR_MIN_PX,
    Math.min(WORKSPACE_SIDEBAR_MAX_PX, window.innerWidth - WORKSPACE_CANVAS_MIN_PX - WORKSPACE_CONVERSATION_MIN_PX),
  )
  return Math.min(Math.max(w, WORKSPACE_SIDEBAR_MIN_PX), max)
}

const clampCanvasWidth = (w: number, sidebarPx: number): number => {
  const max = Math.max(
    WORKSPACE_CANVAS_MIN_PX,
    window.innerWidth - sidebarPx - WORKSPACE_CONVERSATION_MIN_PX,
  )
  return Math.min(Math.max(w, WORKSPACE_CANVAS_MIN_PX), max)
}

/** The four-column frame (see module doc). */
export function CicadaAppFrame({
  useStore,
  renderSlot,
  SessionProvider,
  t,
}: CicadaAppFrameProps) {
  // K6 chat 单列模式（wx 壳右栏 50:50 嵌入）：?layout=chat → 全宽只渲染对话槽
  //（标题行/消息流/输入条原样 = DSH 主对话子页抽出版），隐藏另三列与画布层。
  // M1c workspace 模式：?layout=workspace → 左画布（cicada.canvas）+ 右对话，同一窗口。
  // 布局选择持久化到 localStorage：token 认证后 URL 可能被清理，靠存储记住选择。
  const layout = useMemo(() => {
    if (typeof window === 'undefined') return undefined
    const fromUrl = new URLSearchParams(window.location.search).get('layout')
    if (fromUrl !== null && fromUrl !== '') {
      window.localStorage.setItem('cicada.layout', fromUrl)
      return fromUrl
    }
    return window.localStorage.getItem('cicada.layout') ?? undefined
  }, [])

  // 画布列宽（workspace）：0 = 默认弹性（会话内自适应）；拖拽后为 px 并持久化。
  const [canvasWidth, setCanvasWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    const v = Number(window.localStorage.getItem(CANVAS_WIDTH_KEY))
    return Number.isFinite(v) && v > 0 ? clampCanvasWidth(v, WORKSPACE_SIDEBAR_PX) : 0
  })
  // 侧栏列宽（workspace）：默认 WORKSPACE_SIDEBAR_PX；拖拽后为 px 并持久化
  // （品牌名「Schematic-Cicada」在默认 200px 下放不下——用户实测被截断）。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return WORKSPACE_SIDEBAR_PX
    const v = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(v) && v > 0 ? clampSidebarWidth(v) : WORKSPACE_SIDEBAR_PX
  })
  useEffect(() => {
    if (canvasWidth === 0) return
    window.localStorage.setItem(CANVAS_WIDTH_KEY, String(canvasWidth))
  }, [canvasWidth])
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [handleDragging, setHandleDragging] = useState(false)
  const handleTeardown = useRef<(() => void) | null>(null)
  useEffect(() => () => { handleTeardown.current?.() }, [])

  /**
   * One column-handle drag. Window-level listeners: pointer capture can go
   * silent under automation/CDP, while window events reach both a real mouse
   * and the driver. `apply` receives the live width (preview) and the committed
   * width on pointerup.
   */
  const beginDrag = useCallback((
    e: React.PointerEvent<HTMLDivElement>,
    startWidth: number,
    apply: (px: number) => void,
  ) => {
    e.preventDefault()
    const origin = e.clientX
    let shift = 0
    let frame: number | null = null
    setHandleDragging(true)
    const onMove = (ev: PointerEvent): void => {
      shift = ev.clientX - origin
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null
          apply(startWidth + shift)
        })
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      handleTeardown.current = null
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      setHandleDragging(false)
      apply(startWidth + shift)
    }
    handleTeardown.current = onUp
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const startWidth = canvasWidth === 0
      ? (canvasRef.current?.getBoundingClientRect().width ?? WORKSPACE_CANVAS_MIN_PX)
      : canvasWidth
    beginDrag(e, startWidth, (px) => { setCanvasWidth(clampCanvasWidth(px, sidebarWidth)) })
  }, [beginDrag, canvasWidth, sidebarWidth])

  const onSidebarHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    beginDrag(e, sidebarWidth, (px) => { setSidebarWidth(clampSidebarWidth(px)) })
  }, [beginDrag, sidebarWidth])

  if (layout === 'chat') {
    return (
      <div className={css.chatOnly} data-cicada-chat-only>
        <SessionProvider>{renderSlot('conversation', {})}</SessionProvider>
      </div>
    )
  }
  if (layout === 'workspace') {
    return (
      <div className={css.workspaceFrame} data-cicada-workspace>
        <div
          className={css.workspaceSidebar}
          data-workspace-sidebar
          style={{ flex: `0 0 ${String(sidebarWidth)}px` }}
        >
          {renderSlot('sidebar', { collapsed: false, width: sidebarWidth })}
        </div>
        <div
          className={css.workspaceSidebarHandle}
          data-cicada-sidebar-handle
          data-dragging={handleDragging || undefined}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workspace.sidebar.divider.aria')}
          onPointerDown={onSidebarHandleDown}
        />
        <div
          className={css.workspaceCanvas}
          data-workspace-canvas
          ref={canvasRef}
          style={canvasWidth === 0 ? undefined : { flex: '0 0 auto', width: canvasWidth }}
        >
          <SessionProvider>{renderSlot('cicada.canvas', {})}</SessionProvider>
        </div>
        <div
          className={css.workspaceHandle}
          data-cicada-splitter
          data-dragging={handleDragging || undefined}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workspace.divider.aria')}
          onPointerDown={onHandleDown}
        />
        <div className={css.workspaceConversation} data-workspace-conversation>
          <SessionProvider>{renderSlot('conversation', {})}</SessionProvider>
        </div>
      </div>
    )
  }
  const panels = useStore(s => s)
  // Grid template: sidebar | center (conversation) | pipeline | details.
  // A closed sidebar renders the fixed collapsed rail; closed details render
  // zero width (the subtree stays mounted — never unmount on close).
  const gridTemplateColumns = useMemo(() => {
    const sidebar = panels.sidebar === 0 ? SIDEBAR_COLLAPSED : panels.sidebar
    const details = panels.details === 0 ? 0 : panels.details
    return `${sidebar}px minmax(0, 1fr) ${PIPELINE_DEFAULT}px ${details}px`
  }, [panels.sidebar, panels.details])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')

  return (
    <div
      className={css.frame}
      style={{ gridTemplateColumns }}
      data-sidebar-collapsed={panels.sidebar === 0 || undefined}
      data-details-collapsed={panels.details === 0 || undefined}
    >
      <div className={css.sidebarCol} data-cicada-sidebar>
        {renderSlot('sidebar', {
          collapsed: panels.sidebar === 0,
          width: panels.sidebar === 0 ? SIDEBAR_COLLAPSED : panels.sidebar,
        })}
      </div>
      <div className={css.centerCol} data-cicada-conversation>
        {renderSlot('conversation', {})}
      </div>
      {/* Session-strict slots must render inside the SessionProvider seat
          (same pattern as the native frame's details column): a bare
          renderSlot of a declared session child throws the renderer's
          strict scope-binding check and kills the whole frame (black page).
          The provider withholds while no session is current. */}
      <div className={css.pipelineCol} data-cicada-pipeline aria-label={t('pipeline.aria')}>
        <SessionProvider>{renderSlot('cicada.pipeline', {})}</SessionProvider>
      </div>
      <div className={css.detailsCol} data-cicada-details>
        <SessionProvider>{renderSlot('details', {})}</SessionProvider>
      </div>
      <div className={css.canvasLayer} data-cicada-canvas aria-label={t('canvas.aria')}>
        <SessionProvider>{renderSlot('cicada.canvas', {})}</SessionProvider>
      </div>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      <div className={css.titleRow} data-cicada-title>{productTitle}</div>
    </div>
  )
}

// Re-export for the four-share composition and tests; the frame keeps the
// default export name used by the registration.
export default CicadaAppFrame
