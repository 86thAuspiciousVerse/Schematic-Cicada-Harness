/**
 * CanvasPane (M1c v4): the web schematic surface — SVG render of the engine
 * /scene snapshot (IU coords), viewport (wheel zoom at cursor, middle-drag
 * pan), grid background (50 mil dot lattice + 250 mil wire grid, KiCad-style),
 * and the gesture set: left-click select / left-drag marquee / drag-move,
 * wire draw (the geometry — snap, 45° break point, terminal detection — is
 * engine-side via POST /wire/preview; the pane only forwards pointer input
 * and renders the returned {mid,end} pair), place-by-click (engine grid-aligns
 * the position), delete/undo, lock overlay, and the 「加入到上下文」 context
 * menu. Pure presentation: reads the canvas store + the injected CanvasApi.
 *
 * Interaction contract (wx-era semantics, user-specified):
 *   wheel   = zoom at cursor (native listener, preventDefault)
 *   middle  = pan
 *   left    = click select (engine /hit 6 px acc); drag on a component =
 *             move (grid-aligned); drag on blank = marquee select
 *   wire    = free cursor; click freezes a wire-preview pair (engine);
 *             double-click / right-click / Space / Enter finish; Esc cancels
 *   keys    = 1 select / 2 wire / 3 place, Delete removes selection
 *             (ignored while typing in an input)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasApi, CanvasSelectionItem } from '../canvas_driver.ts'
import type { createCanvasStore } from '../canvas_store.ts'
import css from './CanvasPane.module.css'

type CanvasPaneProps =
  & PropsRuntime<'cicada.canvas'>
  & PropsStore<ReturnType<typeof createCanvasStore>>
  & PropsLocale<'cicada.canvas'>
  & { canvas?: CanvasApi }

type Tool = 'select' | 'wire' | 'place'
type DragMode = 'none' | 'pan' | 'marquee' | 'move'

interface DragState {
  mode: DragMode
  px: number
  py: number
  moved: number
  x0: number
  y0: number
  /** Press position in engine IU (move delta origin / click re-select). */
  pressIU: [number, number]
  /** Component hit at press (drag-move candidate); null = blank press. */
  refdes: string | null
  /** An async engine /hit is in flight; its result may upgrade none → move. */
  hitPending: boolean
}

export function CanvasPane({
  useStore,
  actions,
  t,
  canvas,
}: CanvasPaneProps) {
  const s = useStore((state) => state)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState>({
    mode: 'none', px: 0, py: 0, moved: 0, x0: 0, y0: 0, pressIU: [0, 0], refdes: null, hitPending: false,
  })
  /** In-flight /hit press results must not mutate a newer drag (slow engine). */
  const dragGenRef = useRef(0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const marquee = s.marquee
  const [tool, setTool] = useState<Tool>('select')
  const [pendingLib, setPendingLib] = useState('cicada:R')

  // WIRE_DRAW（wx 移植 + 引擎几何）：按下点（UP ≤3px 才算点击冻结）；
  // posture 继承上一冻结段方向；引擎预览 in-flight 节流（1 个在途 + 追平最新）。
  const wirePressRef = useRef<{ x: number; y: number } | null>(null)
  const wirePrevDirRef = useRef<[number, number] | null>(null)
  const wirePostureRef = useRef(true)
  const previewBusyRef = useRef(false)
  const previewPendingRef = useRef<[number, number] | null>(null)
  /** freeze/取消时递增：使在途预览响应失效（防旧覆盖新链）。 */
  const previewSeqRef = useRef(0)

  useEffect(() => {
    void canvas?.init()
  }, [canvas])

  // 收尾保险：快速手势触发 pointercancel 时 pointerup 可能不来——
  // 全局监听任何 pointerup/cancel，强制清拖拽/框选/移动预览（滞留根因）。
  useEffect(() => {
    const cleanup = (): void => {
      dragGenRef.current += 1
      clearDrag()
      actions.setMarquee(null)
      actions.setMoveGhost(null)
    }
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    return () => {
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
    }
  })

  const ups = s.viewport.scale
  /** Pick tolerance in IU: KiCad HITTEST ~6 screen px, capped against RTree
   *  degeneration at extreme zoom-out (wx acc_iu formula). */
  const hitTol = Math.min(Math.max(Math.round(6 / ups), 1), 10_000)
  /** Engine snap radius (IU): max(acc, 16 px / scale) — slightly wider than
   *  KiCad's 12 px so a wire aimed at a pin lands on it; the panes only
   *  converts screen px to IU (snap/geometry itself lives in the engine). */
  const snapRad = Math.max(hitTol, Math.round(16 / ups))
  const toIU = (pxX: number, pxY: number): [number, number] => [
    Math.round((pxX - s.viewport.ox) / ups),
    Math.round((pxY - s.viewport.oy) / ups),
  ]

  const resetWire = (): void => {
    wirePressRef.current = null
    wirePrevDirRef.current = null
    wirePostureRef.current = true
    previewBusyRef.current = false
    previewPendingRef.current = null
    previewSeqRef.current += 1
    actions.setWireDraft(null)
  }

  /** Engine preview with in-flight coalescing: at most one request in the air,
   *  the latest cursor wins, seq guards against stale responses after freeze. */
  const issuePreview = (chain: [number, number][], raw: [number, number]): void => {
    if (chain.length === 0) return
    if (previewBusyRef.current) {
      previewPendingRef.current = raw
      return
    }
    previewBusyRef.current = true
    const seq = previewSeqRef.current
    const anchor = chain[chain.length - 1] as [number, number]
    void canvas?.wirePreview(anchor, raw, wirePrevDirRef.current, wirePostureRef.current, snapRad).then((res) => {
      previewBusyRef.current = false
      const pend = previewPendingRef.current
      previewPendingRef.current = null
      if (seq === previewSeqRef.current && res !== undefined) {
        actions.setWireDraft({
          chain,
          mid: [res.mid[0], res.mid[1]],
          end: [res.end[0], res.end[1]],
        })
      }
      if (pend !== null && seq === previewSeqRef.current) issuePreview(chain, pend)
    })
  }

  /** 冻结当前预览折点对（wx freeze_wire_pair，几何=引擎 /wire/preview 返回值）。 */
  const freezeWirePair = async (raw: [number, number]): Promise<boolean> => {
    previewSeqRef.current += 1
    const chain = s.wireDraft?.chain ?? []
    const anchor = chain.length > 0 ? chain[chain.length - 1] as [number, number] : raw
    const res = await canvas?.wirePreview(anchor, raw, wirePrevDirRef.current, wirePostureRef.current, snapRad)
    if (res === undefined) return false
    const cur: [number, number] = [res.end[0], res.end[1]]
    const mid: [number, number] = [res.mid[0], res.mid[1]]
    if (chain.length === 0) {
      actions.setWireDraft({ chain: [cur], mid: null, end: null })
    } else {
      const anchorP = chain[chain.length - 1] as [number, number]
      const next = (mid[0] === anchorP[0] && mid[1] === anchorP[1]) ? chain : [...chain, mid]
      const last = next[next.length - 1] as [number, number]
      const final = (cur[0] === last[0] && cur[1] === last[1]) ? next : [...next, cur]
      actions.setWireDraft({ chain: final, mid: null, end: null })
      wirePrevDirRef.current = [cur[0] - mid[0], cur[1] - mid[1]]
      wirePostureRef.current = true
    }
    return res.terminal
  }

  const finishWire = async (): Promise<void> => {
    const chain = s.wireDraft?.chain
    if (chain === undefined || chain.length < 2) return
    const ok = await (canvas?.drawWire(chain) ?? Promise.resolve(false))
    if (ok) {
      resetWire()
      actions.setStatus(t('status.wireDone'))
    }
  }

  // 滚轮缩放：原生监听（React onWheel 在部分 Edge 下不可靠且 passive），
  // preventDefault 抑制页面滚动。
  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const onWheelNative = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const rect = svg.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25
      actions.zoom(factor, event.clientX - rect.left, event.clientY - rect.top)
      setMenu(null)
      actions.setStatus(`zoom ${s.viewport.scale.toFixed(4)}`)
    }
    svg.addEventListener('wheel', onWheelNative, { passive: false })
    return () => svg.removeEventListener('wheel', onWheelNative)
  })

  const onPointerDown = (event: React.PointerEvent): void => {
    setMenu(null)
    // 锁遮罩已挡住指针；这里再兜一层（键盘/程序化事件也走不到画布编辑）。
    if (locked) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (event.button === 1) {
      dragRef.current = {
        mode: 'pan', px: event.clientX, py: event.clientY, moved: 0, x0: event.clientX, y0: event.clientY,
        pressIU: [0, 0], refdes: null, hitPending: false,
      }
      svgRef.current?.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    if (tool === 'wire') {
      // WIRE_DRAW 中按下=记录（UP 无位移才算"点击"冻结——按住拖动=仅预览不冻结）
      wirePressRef.current = { x: event.clientX, y: event.clientY }
      svgRef.current?.setPointerCapture(event.pointerId)
      return
    }
    dragGenRef.current += 1
    const iu = rect === undefined ? [0, 0] : toIU(event.clientX - rect.left, event.clientY - rect.top)
    dragRef.current = {
      mode: 'none', px: event.clientX, py: event.clientY, moved: 0, x0: event.clientX, y0: event.clientY,
      pressIU: [iu[0], iu[1]], refdes: null, hitPending: tool === 'select',
    }
    svgRef.current?.setPointerCapture(event.pointerId)
    if (tool === 'place') {
      // 放置坐标的网格对齐由引擎 /ops place-symbol 负责（几何唯一权威在引擎）。
      void canvas?.place(
        pendingLib.startsWith('cicada:') ? pendingLib : `cicada:${pendingLib}`,
        iu[0],
        iu[1],
      )
      return
    }
    // select 工具：按下时问一次 /hit，命中组件 → 移动候选；空白 → 框选。
    // 结果晚到（>6px 已入框选）则以手势为准。
    const gen = dragGenRef.current
    void canvas?.hitAt(iu[0], iu[1], hitTol).then((hit) => {
      const d = dragRef.current
      if (gen !== dragGenRef.current) return
      d.hitPending = false
      if (d.mode === 'none' && d.moved <= 6 && hit?.kind === 'component') {
        d.mode = 'move'
        d.refdes = hit.refdes ?? null
      }
    })
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    if (tool === 'wire') {
      const rect = svgRef.current?.getBoundingClientRect()
      const draft = s.wireDraft
      if (rect !== undefined && draft !== null && draft.chain.length > 0) {
        const [rawX, rawY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
        issuePreview(draft.chain, [rawX, rawY])
      }
      return
    }
    const drag = dragRef.current
    if (drag.mode === 'none' && (event.buttons === 0)) return
    const dx = event.clientX - drag.px
    const dy = event.clientY - drag.py
    if (drag.mode === 'none' && (event.buttons & 1) !== 0 && tool === 'select') {
      drag.moved += Math.abs(dx) + Math.abs(dy)
      if (drag.moved > 6) {
        drag.mode = 'marquee'
        drag.hitPending = false
      }
    }
    if (drag.mode === 'marquee') {
      const rect = boxRef.current?.getBoundingClientRect()
      if (rect !== undefined) {
        actions.setMarquee({
          x0: drag.x0 - rect.left,
          y0: drag.y0 - rect.top,
          x1: event.clientX - rect.left,
          y1: event.clientY - rect.top,
        })
      }
      actions.setStatus(`marquee ${event.clientX.toFixed(0)},${event.clientY.toFixed(0)}`)
    } else if (drag.mode === 'move') {
      drag.moved += Math.abs(dx) + Math.abs(dy)
      const rect = svgRef.current?.getBoundingClientRect()
      if (rect !== undefined && drag.refdes !== null) {
        const [rawX, rawY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
        const mx = Math.round(rawX / 12700) * 12700 - Math.round(drag.pressIU[0] / 12700) * 12700
        const my = Math.round(rawY / 12700) * 12700 - Math.round(drag.pressIU[1] / 12700) * 12700
        const refdeses = selIncludesRefdes(drag.refdes)
          ? s.selection.filter((sel) => sel.kind === 'component').map((sel) => sel.refdes)
          : [drag.refdes]
        actions.setMoveGhost({ refdeses, dx: mx, dy: my })
        actions.setStatus(`move ${mx},${my}`)
      }
    } else if (drag.mode === 'pan') {
      actions.panBy(dx, dy)
      actions.setStatus(`pan ${s.viewport.ox.toFixed(0)},${s.viewport.oy.toFixed(0)}`)
    }
    drag.px = event.clientX
    drag.py = event.clientY
  }

  const onPointerUp = (event: React.PointerEvent): void => {
    if (tool === 'wire') {
      const press = wirePressRef.current
      wirePressRef.current = null
      const rect = svgRef.current?.getBoundingClientRect()
      if (press !== null && rect !== undefined) {
        const dx = event.clientX - press.x
        const dy = event.clientY - press.y
        if (dx * dx + dy * dy <= 3 * 3) {
          const [rawX, rawY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
          void freezeWirePair([rawX, rawY]).then((terminal) => {
            if (terminal) void finishWire()
          })
        }
      }
      return
    }
    const drag = dragRef.current
    dragGenRef.current += 1
    const rect = svgRef.current?.getBoundingClientRect()
    dragRef.current = {
      mode: 'none', px: 0, py: 0, moved: 0, x0: 0, y0: 0, pressIU: [0, 0], refdes: null, hitPending: false,
    }
    if (rect === undefined) return
    if (drag.mode === 'marquee') {
      actions.setMarquee(null)
      const [aX, aY] = toIU(drag.x0 - rect.left, drag.y0 - rect.top)
      const [bX, bY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
      const loX = Math.min(aX, bX)
      const hiX = Math.max(aX, bX)
      const loY = Math.min(aY, bY)
      const hiY = Math.max(aY, bY)
      const inside = (s.scene?.components ?? [])
        .filter((c) => c.x >= loX && c.x <= hiX && c.y >= loY && c.y <= hiY)
        .map((c) => ({ kind: 'component' as const, refdes: c.refdes }))
      const insideWires = (s.scene?.wires ?? [])
        .filter((w) => w.points.every(([x, y]) => x >= loX && x <= hiX && y >= loY && y <= hiY))
        .map((w) => ({ kind: 'wire' as const, uuid: w.uuid }))
      actions.setSelection([...inside, ...insideWires])
      return
    }
    if (drag.mode === 'move') {
      actions.setMoveGhost(null)
      if (drag.refdes !== null && drag.moved >= 6) {
        const [rawX, rawY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
        const dx = Math.round(rawX / 12700) * 12700 - Math.round(drag.pressIU[0] / 12700) * 12700
        const dy = Math.round(rawY / 12700) * 12700 - Math.round(drag.pressIU[1] / 12700) * 12700
        const refdeses = selIncludesRefdes(drag.refdes)
          ? s.selection.filter((sel) => sel.kind === 'component').map((sel) => sel.refdes)
          : [drag.refdes]
        void canvas?.moveBy(refdeses, dx, dy).then((ok) => {
          if (ok) actions.setSelection(refdeses)
        })
      } else if (drag.refdes !== null) {
        void canvas?.hitAndSelect(drag.pressIU[0], drag.pressIU[1], hitTol)
      }
      return
    }
    if (drag.mode === 'none' && event.button === 0 && tool === 'select') {
      const [iuX, iuY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
      void canvas?.hitAndSelect(iuX, iuY, hitTol)
    }
  }

  const onDoubleClick = (event: React.MouseEvent): void => {
    if (tool === 'wire' && s.wireDraft !== null) {
      event.preventDefault()
      void finishWire()
    }
  }

  const clearDrag = (): void => {
    dragRef.current = {
      mode: 'none', px: 0, py: 0, moved: 0, x0: 0, y0: 0, pressIU: [0, 0], refdes: null, hitPending: false,
    }
  }

  // 快捷键（1/2/3 切工具、Space/Enter 结束画线、Esc 取消、Delete 删除）。
  // 输入框内击键永远不抢（对话输入条与画布同页）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const el = event.target as HTMLElement | null
      if (el !== null && el.closest('input, textarea, select, [contenteditable]') !== null) return
      // 锁期间画布只读：只允许 Esc 取消本地草稿，不允许删除/撤销/改工具。
      if (locked) {
        if (event.key === 'Escape') {
          resetWire()
          actions.clearSelection()
        }
        return
      }
      if (event.key === 'Escape') {
        if (tool === 'wire' && s.wireDraft !== null) {
          resetWire()
          actions.setStatus(t('status.wireHint'))
        } else if (tool === 'place') {
          setTool('select')
        } else {
          actions.clearSelection()
        }
        return
      }
      if (tool === 'wire' && s.wireDraft !== null && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault()
        const chain = s.wireDraft.chain
        if (chain.length >= 2) void finishWire()
        else actions.setStatus(t('status.wireFewPoints'))
        return
      }
      if (event.key === '1') setTool('select')
      else if (event.key === '2') setTool('wire')
      else if (event.key === '3') setTool('place')
      else if (event.key === 'Delete' && tool === 'select' && s.selection.length > 0) {
        void canvas?.removeSelection(s.selection)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    // wx 语义：画线中右键 = 结束画线（不弹菜单）
    if (tool === 'wire' && s.wireDraft !== null) {
      void finishWire()
      return
    }
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const addToContext = async (): Promise<void> => {
    const items = s.selection.flatMap((sel) =>
      sel.kind === 'component' ? refreshSelection(sel.refdes) : [{ kind: 'wire' as const, uuid: sel.uuid }],
    )
    if (items.length > 0) {
      const msg = await (canvas?.addToContext(items) ?? Promise.resolve(''))
      actions.setStatus(msg)
    }
    setMenu(null)
  }

  const refreshSelection = (refdes: string): CanvasSelectionItem[] => {
    const comp = s.scene?.components.find((c) => c.refdes === refdes)
    if (comp === undefined) return [{ kind: 'component', refdes }]
    return [{
      kind: 'component' as const,
      refdes,
      value: comp.value,
      pins: comp.pins.map((p) => p.number),
    }]
  }

  const remove = async (): Promise<void> => {
    await canvas?.removeSelection(s.selection)
  }

  const selected = new Set(
    s.selection.filter((sel): sel is { kind: 'component'; refdes: string } => sel.kind === 'component')
      .map((sel) => sel.refdes),
  )
  const selectedWires = new Set(
    s.selection.filter((sel): sel is { kind: 'wire'; uuid: string } => sel.kind === 'wire')
      .map((sel) => sel.uuid),
  )
  const selIncludesRefdes = (refdes: string): boolean =>
    s.selection.some((sel) => sel.kind === 'component' && sel.refdes === refdes)
  // 只读遮罩只属于「AI 回合进行中」：human-editing 是人自己在画（持租约是为了挡 AI），
  // 绝不能被自己的租约锁住（2026-09-08 实测：人一画线就出现「AI 正在修改原理图…」）。
  const locked = s.lock === 'agent-editing'
  const ghost = s.moveGhost
  const ghostSet = new Set(ghost?.refdeses ?? [])
  const draft = s.wireDraft
  const draftAnchor = draft !== null && draft.chain.length > 0
    ? draft.chain[draft.chain.length - 1] as [number, number]
    : null

  // 网格（KiCad 点阵 50mil + 250mil 线格；随缩放/平移对齐 IU 网格）。
  const gridPx = 12700 * ups
  const bigPx = gridPx * 5
  const showDots = gridPx >= 5
  const showLines = bigPx >= 5
  const boxStyle: React.CSSProperties = {
    backgroundColor: '#fafaf7',
    backgroundImage: [
      showDots ? 'radial-gradient(circle at 1px 1px, rgba(0, 0, 0, 0.16) 1px, transparent 1.8px)' : 'none',
      showLines
        ? `repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.07) 0 1px, transparent 1px ${bigPx}px), repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.07) 0 1px, transparent 1px ${bigPx}px)`
        : 'none',
    ].join(', '),
    backgroundSize: showDots ? `${gridPx}px ${gridPx}px` : 'auto',
    backgroundPosition: [
      showDots ? `${s.viewport.ox % gridPx}px ${s.viewport.oy % gridPx}px` : '0 0',
      showLines ? `${s.viewport.ox % bigPx}px ${s.viewport.oy % bigPx}px` : '0 0',
    ].join(', '),
  }

  return (
    <div className={css.root} data-cicada-canvas-pane>
      <div className={css.toolbar}>
        <button type="button" data-active={tool === 'select' || undefined} onClick={() => setTool('select')}>
          {t('tool.select')}
        </button>
        <button type="button" data-active={tool === 'wire' || undefined} onClick={() => { setTool('wire'); resetWire(); actions.setStatus(t('status.wireHint')) }}>
          {t('tool.wire')}
        </button>
        <button type="button" data-active={tool === 'place' || undefined} disabled={locked} onClick={() => { setTool('place'); actions.setStatus(t('status.placeHint')) }}>
          {t('tool.place')}
        </button>
        <button type="button" disabled={locked} onClick={() => void canvas?.undo()}>{t('undo')}</button>
        <button type="button" disabled={locked} onClick={() => void remove()}>{t('delete')}</button>
        <button type="button" onClick={() => void canvas?.refresh()}>{t('refresh')}</button>
        <button type="button" onClick={() => canvas?.fit()}>{t('tool.fit')}</button>
        <span className={css.status}>{s.status}</span>
      </div>
      {tool === 'place' && (
        <div className={css.libPanel}>
          <select value={pendingLib} onChange={(e) => setPendingLib(e.target.value)}>
            {s.libList.map((item) => (
              <option key={item.name} value={`cicada:${item.name}`}>
                {item.name} ({item.pins} 引脚)
              </option>
            ))}
          </select>
          <span className={css.libHint}>{t('status.placeHint')}</span>
        </div>
      )}
      <div className={css.canvasBox} ref={boxRef} style={boxStyle}>
        <svg
          ref={svgRef}
          className={css.svg}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onPointerLeave={clearDrag}
          onPointerCancel={clearDrag}
          onContextMenu={onContextMenu}
          style={{ cursor: locked ? 'default' : tool === 'wire' ? 'copy' : 'crosshair', touchAction: 'none' }}
        >
          <g transform={`translate(${s.viewport.ox} ${s.viewport.oy}) scale(${ups})`}>
            {(s.scene?.wires ?? []).map((w, i) => {
              const wSel = selectedWires.has(w.uuid)
              return (
                <polyline
                  key={w.uuid ?? i}
                  data-selected={wSel || undefined}
                  points={w.points.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none" stroke={wSel ? '#0969da' : '#1a7f37'}
                  strokeWidth={wSel ? 1600 : 600}
                  strokeLinecap="square"
                />
              )
            })}
            {(s.scene?.junctions ?? []).map((j, i) => (
              <circle key={i} cx={j.x} cy={j.y} r={900} fill="#1a7f37" />
            ))}
            {(s.scene?.components ?? []).map((c) => {
              const bx = c.body.rect.w / 2
              const by = c.body.rect.h / 2
              const sel = selected.has(c.refdes)
              const moveT = ghost !== null && ghostSet.has(c.refdes)
                ? `translate(${ghost.dx} ${ghost.dy})`
                : undefined
              return (
                <g key={c.refdes} data-selected={sel || undefined} transform={moveT}>
                  <rect
                    x={c.x - bx}
                    y={c.y - by}
                    width={c.body.rect.w}
                    height={c.body.rect.h}
                    fill="#fff"
                    stroke={sel ? '#0969da' : '#333'}
                    strokeWidth={sel ? 1600 : 600}
                  />
                  {c.pins.map((p, i) => (
                    <g key={`${c.refdes}-${p.number}`}>
                      <line
                        x1={p.x}
                        y1={p.y}
                        x2={p.ix}
                        y2={p.iy}
                        stroke={sel ? '#0969da' : '#666'}
                        strokeWidth={600}
                      />
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={Math.max(1200, 2.2 / ups)}
                        fill={sel ? '#0969da' : '#666'}
                        stroke="#fafaf7"
                        strokeWidth={0.7 / ups}
                      />
                    </g>
                  ))}
                  <text x={c.x} y={c.y - by - 3000} fontSize={3500} textAnchor="middle" fill="#24292f">
                    {c.refdes} {c.value}
                  </text>
                </g>
              )
            })}
            {(s.scene?.labels ?? []).map((l, i) => (
              <text key={i} x={l.x} y={l.y - 2000} fontSize={3500} fill="#24292f">{l.text}</text>
            ))}
            {draft !== null && draft.chain.length > 0 && (
              <>
                <polyline
                  points={draft.chain.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none" stroke="#d4a72c" strokeWidth={600} strokeLinecap="square" strokeLinejoin="miter"
                />
                {draft.mid !== null && draft.end !== null && draftAnchor !== null && (
                  <polyline
                    points={`${draftAnchor[0]},${draftAnchor[1]} ${draft.mid[0]},${draft.mid[1]} ${draft.end[0]},${draft.end[1]}`}
                    fill="none" stroke="#d4a72c" strokeWidth={600} strokeDasharray="1200 1200" strokeLinecap="square" strokeLinejoin="miter"
                  />
                )}
                {draft.chain.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={700} fill="#d4a72c" />
                ))}
              </>
            )}
          </g>
          {marquee !== null && (
            <rect
              x={Math.min(marquee.x0, marquee.x1)}
              y={Math.min(marquee.y0, marquee.y1)}
              width={Math.abs(marquee.x1 - marquee.x0)}
              height={Math.abs(marquee.y1 - marquee.y0)}
              fill="rgba(9,105,218,0.12)"
              stroke="#0969da"
              strokeWidth={1}
            />
          )}
        </svg>
        {marquee !== null && (
          <div
            className={css.marquee}
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
        {locked && <div className={css.lockOverlay}>{t('locked')}</div>}
        {menu !== null && (
          <div className={css.contextMenu} style={{ left: menu.x, top: menu.y }}>
            <button type="button" disabled={s.selection.length === 0} onClick={() => void addToContext()}>
              {t('menu.addContext')} ({s.selection.length})
            </button>
            <button type="button" onClick={() => { actions.clearSelection(); setMenu(null) }}>
              {t('menu.clear')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default CanvasPane
