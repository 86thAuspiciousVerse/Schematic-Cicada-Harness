/**
 * Canvas store (M1c): the web canvas pane's shared viewing/interaction state —
 * scene snapshot (engine IU), viewport (px-per-IU + pan), selection refdeses,
 * editor lock, and the loaded library list. The driving channel (engine HTTP +
 * /cicada/editor/ws frames) lives in canvas_driver.ts, which publishes through
 * the actions here; the component only reads the store and fires gestures.
 * All live-data values are plain JSON (engine contract, docs/02).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** /scene payload (docs/02 §3; coordinates IU ints). */
export interface CanvasScene {
  file: string
  hash: string
  version: string
  components: {
    refdes: string
    libId: string
    name: string
    x: number
    y: number
    rotation: number
    value: string
    fields: Record<string, string>
    pins: { number: string; name: string; x: number; y: number; ix: number; iy: number }[]
    body: { rect: { w: number; h: number } }
  }[]
  wires: { uuid: string; points: [number, number][]; net: string }[]
  junctions: { x: number; y: number }[]
  labels: { text: string; x: number; y: number }[]
  no_connects: { x: number; y: number }[]
}

export interface CanvasLibItem { name: string; pins: number }

type CanvasState = {
  ready: boolean
  engineUrl: string
  engineToken: string
  scene: CanvasScene | null
  /** px per IU; pan origin in px. */
  viewport: { scale: number; ox: number; oy: number }
  selection: string[]
  lock: 'idle' | 'agent-editing' | 'human-editing'
  libList: CanvasLibItem[]
  status: string
}

type CanvasActions = {
  setReady: (d: CanvasState, ready: boolean) => void
  setEngine: (d: CanvasState, url: string, token: string) => void
  setScene: (d: CanvasState, scene: CanvasScene) => void
  setViewport: (d: CanvasState, viewport: CanvasState['viewport']) => void
  zoom: (d: CanvasState, factor: number, cx: number, cy: number) => void
  panBy: (d: CanvasState, dx: number, dy: number) => void
  setSelection: (d: CanvasState, refdeses: string[]) => void
  clearSelection: (d: CanvasState) => void
  setLock: (d: CanvasState, lock: CanvasState['lock']) => void
  setLibList: (d: CanvasState, items: CanvasLibItem[]) => void
  setStatus: (d: CanvasState, status: string) => void
}

function clampScale(s: number): number {
  return Math.min(20, Math.max(0.01, s))
}

/** Create the canvas store handle (factory-only; the framework instantiates). */
export function createCanvasStore(): EngineStoreHandle<CanvasState, CanvasActions> {
  return defineStore({
    init: (): CanvasState => ({
      ready: false,
      engineUrl: '',
      engineToken: '',
      scene: null,
      viewport: { scale: 0.01, ox: 0, oy: 0 },
      selection: [],
      lock: 'idle',
      libList: [],
      status: '',
    }),
    actions: {
      setReady: (d, ready) => { d.ready = ready },
      setEngine: (d, url, token) => { d.engineUrl = url; d.engineToken = token },
      setScene: (d, scene) => { d.scene = scene },
      setViewport: (d, viewport) => { d.viewport = viewport },
      zoom: (d, factor, cx, cy) => {
        const s0 = d.viewport.scale
        const s1 = clampScale(s0 * factor)
        // keep the cursor-anchored IU point fixed
        const k = s1 / s0
        d.viewport = {
          scale: s1,
          ox: cx - (cx - d.viewport.ox) * k,
          oy: cy - (cy - d.viewport.oy) * k,
        }
      },
      panBy: (d, dx, dy) => {
        d.viewport = { ...d.viewport, ox: d.viewport.ox + dx, oy: d.viewport.oy + dy }
      },
      setSelection: (d, refdeses) => { d.selection = refdeses },
      clearSelection: (d) => { d.selection = [] },
      setLock: (d, lock) => { d.lock = lock },
      setLibList: (d, items) => { d.libList = items },
      setStatus: (d, status) => { d.status = status },
    },
  })
}
