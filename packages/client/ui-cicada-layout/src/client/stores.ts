/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module cache (a de-facto
 * singleton surviving plugin reloads). register() receives the factory
 * (exclusive use: the framework instantiates per entry), AppFrame derives its
 * PropsStore share from the return type, and the service face receives the
 * bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { DETAILS_DEFAULT, SIDEBAR_DEFAULT } from './columns.ts'

/** Layout store state: panel width preferences in px (0 = closed). */
type CicadaLayoutState = { sidebar: number; details: number }

/** Annotation twin of the actions literal below (drift fails assignability at defineStore). */
type CicadaLayoutActions = {
  setSidebar: (draft: CicadaLayoutState, px: number) => void
  setDetails: (draft: CicadaLayoutState, px: number) => void
  toggleSidebar: (draft: CicadaLayoutState) => void
  openDetails: (draft: CicadaLayoutState) => void
  closeDetails: (draft: CicadaLayoutState) => void
}

/**
 * Create the cicada layout panel store handle. Same width semantics as the
 * native ui-layout store; the pipeline column keeps a fixed contract width
 * (PIPELINE_DEFAULT in columns.ts) and is not part of this state.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createCicadaLayoutStore(): EngineStoreHandle<CicadaLayoutState, CicadaLayoutActions> {
  const handle = defineStore({
    init: (): CicadaLayoutState => ({ sidebar: SIDEBAR_DEFAULT, details: 0 }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = px },
      setDetails: (d, px: number) => { d.details = px },
      toggleSidebar: (d) => { d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0 },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
    },
  })
  return handle
}
