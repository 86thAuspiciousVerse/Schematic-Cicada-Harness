/**
 * CicadaLayoutController: the cross-plugin panel-action face behind ctx.layout.
 * The contract mirrors the native ui-layout service so existing consumers
 * (ui-sidebar toggling, ui-chat opening details) keep working unchanged while
 * the cicada frame owns the root slot. Panel geometry lives in the root
 * entry's layout store (stores.ts); writes stay inside the store's declared
 * action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createCicadaLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type CicadaPanelActions = BoundActions<ReturnType<typeof createCicadaLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other plugins
 * may trigger — and exactly what a test fake must supply. The attachPanels
 * wiring hook stays on the concrete class (root-entry assembly only).
 */
export interface ICicadaLayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class CicadaLayoutController implements ICicadaLayout {
  #panels: CicadaPanelActions | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect).
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: CicadaPanelActions): void {
    this.#panels = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  #require(): CicadaPanelActions {
    if (this.#panels === undefined) throw new Error('cicada-layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
