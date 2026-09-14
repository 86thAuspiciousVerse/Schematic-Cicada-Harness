/**
 * CanvasPane (M1c): the web schematic surface — SVG render of the engine
 * /scene snapshot (IU coords), viewport (wheel zoom at cursor, drag pan),
 * hit-select → engine, placement from the loaded library list, delete/undo,
 * lock overlay, and the 「加入到上下文」 right-click menu. Pure presentation:
 * reads the canvas store + the injected CanvasApi; no ctx, no subscription
 * machinery of its own (the driver owns the channels).
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasApi, CanvasSelectionItem } from './canvas_driver.ts'
import type { createCanvasStore } from './canvas_store.ts'
import css from './canvas.module.css'

type CanvasPaneProps =
  & PropsRuntime<'cicada.canvas'>
  & PropsStore<ReturnType<typeof createCanvasStore>>
  & PropsLocale<'cicada.layout'>
  & { canvas?: CanvasApi }

export function CanvasPane({
  useStore,
  t,
  canvas,
}: CanvasPaneProps) {
  const s = useStore((state) => state)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [tool, setTool] = useState<'select' | 'place'>('select')
  const [pendingLib, setPendingLib] = useState('cicada:R')

  useEffect(() => {
    void canvas?.init()
  }, [canvas])

  const ups = s.viewport.scale
  const toSvg = (x: number, y: number): [number, number] => [
    s.viewport.ox + x * ups,
    s.viewport.oy + y * ups,
  ]
  const toIU = (pxX: number, pxY: number): [number, number] => [
    Math.round((pxX - s.viewport.ox) / ups),
    Math.round((pxY - s.viewport.oy) / ups),
  ]

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

  const onWheel = (event: React.WheelEvent): void => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const cx = event.clientX - rect.left
    const cy = event.clientY - rect.top
    const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25
    s.actions.zoom(factor, cx, cy)
  }

  const panRef = useRef<{ px: number; py: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button === 1) {
      panRef.current = { px: event.clientX, py: event.clientY }
      return
    }
    if (event.button !== 0) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const [iuX, iuY] = toIU(event.clientX - rect.left, event.clientY - rect.top)
    void canvas?.hitAndSelect(iuX, iuY)
  }
  const onPointerMove = (event: React.PointerEvent): void => {
    if (panRef.current === null) return
    s.actions.panBy(event.clientX - panRef.current.px, event.clientY - panRef.current.py)
    panRef.current = { px: event.clientX, py: event.clientY }
  }
  const onPointerUp = (): void => { panRef.current = null }
  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  const addToContext = async (): Promise<void> => {
    const items = s.selection.flatMap(refreshSelection)
    if (items.length > 0) {
      const msg = await (canvas?.addToContext(items) ?? Promise.resolve(''))
      s.actions.setStatus(msg)
    }
    setMenu(null)
  }
  const selectRefdes = (refdes: string): void => { s.actions.setSelection([refdes]) }
  const place = async (): Promise<void> => {
    // 放置到视野中心（IU）
    const [iuX, iuY] = toIU(300, 300)
    await canvas?.place(pendingLib.startsWith('cicada:') ? pendingLib : `cicada:${pendingLib}`, iuX, iuY)
    setTool('select')
  }
  const remove = async (): Promise<void> => { await canvas?.removeSelection(s.selection) }

  const selected = new Set(s.selection)
  const locked = s.lock !== 'idle'

  return (
    <div className={css.root} data-cicada-canvas-pane>
      <div className={css.toolbar}>
        <button type="button" data-active={tool === 'select' || undefined} onClick={() => setTool('select')}>
          {t('canvas.tool.select')}
        </button>
        <button type="button" data-active={tool === 'place' || undefined} onClick={() => setTool('place')}>
          {t('canvas.tool.place')}
        </button>
        <button type="button" onClick={() => void canvas?.undo()}>{t('canvas.undo')}</button>
        <button type="button" onClick={() => void remove()}>{t('canvas.delete')}</button>
        <button type="button" onClick={() => void canvas?.refresh()}>{t('canvas.refresh')}</button>
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
          <button type="button" onClick={() => void place()}>{t('canvas.place.confirm')}</button>
        </div>
      )}
      <div className={css.canvasBox}>
        <svg
          ref={svgRef}
          className={css.svg}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onContextMenu={onContextMenu}
          style={{ cursor: locked ? 'default' : 'crosshair' }}
        >
          <g transform={`translate(${s.viewport.ox} ${s.viewport.oy}) scale(${ups})`}>
            <rect x={-1e6} y={-1e6} width={2e6} height={2e6} fill="#fafaf7" />
            {(s.scene?.wires ?? []).map((w, i) => (
              <polyline
                key={w.uuid ?? i}
                points={w.points.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none" stroke="#1a7f37" strokeWidth={600} strokeLinecap="square"
              />
            ))}
            {(s.scene?.junctions ?? []).map((j, i) => (
              <circle key={i} cx={j.x} cy={j.y} r={900} fill="#1a7f37" />
            ))}
            {(s.scene?.components ?? []).map((c) => {
              const [bx, by] = [c.body.rect.w / 2, c.body.rect.h / 2]
              const sel = selected.has(c.refdes)
              return (
                <g key={c.refdes} data-active={sel || undefined} onClick={(e) => { e.stopPropagation(); selectRefdes(c.refdes) }}>
                  <rect
                    x={c.x - bx} y={c.y - by} width={c.body.rect.w} height={c.body.rect.h}
                    fill="#fff" stroke={sel ? '#0969da' : '#333'} strokeWidth={sel ? 1600 : 600}
                  />
                  {c.pins.map((p, i) => (
                    <line
                      key={`${c.refdes}-${p.number}`} x1={p.x} y1={p.y} x2={p.ix} y2={p.iy}
                      stroke={sel ? '#0969da' : '#666'} strokeWidth={600}
                    />
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
          </g>
        </svg>
        {locked && <div className={css.lockOverlay}>{t('canvas.locked')}</div>}
        {menu !== null && (
          <div className={css.contextMenu} style={{ left: menu.x, top: menu.y }}>
            <button type="button" disabled={s.selection.length === 0} onClick={() => void addToContext()}>
              {t('canvas.menu.addContext')} ({s.selection.length})
            </button>
            <button type="button" onClick={() => { s.actions.clearSelection(); setMenu(null) }}>
              {t('canvas.menu.clear')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default CanvasPane
