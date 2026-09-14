/**
 * Workspace selector chip, registered into the conversation composer's
 * 'conversation.input.left' slot — it renders beside the PermissionSelect
 * (the "Workspace Write" 旁边, K6 用户裁定). The chip shows the current
 * session's cwd; picking another workspace connects and opens a blank
 * session there (DSH `selectWorkspace` semantics, unchanged).
 */
import { useState } from 'react'
import type { InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WorkspaceSelect.module.css'

type WorkspaceSelectProps =
  & PropsRuntime<'conversation.input.left'>
  & { zone: InputZone }
  & PropsLocale<'cicada.layout'>

/** Injected by the register's inject factory (see index.ts) — runtime only. */
export interface WorkspaceSwitch {
  /** Connect + open a blank session in the chosen workspace (DSH semantics). */
  switchWorkspace?: (workspaceId: string) => Promise<void>
}

export function WorkspaceSelect(props: WorkspaceSelectProps) {
  const { zone, useSessions, useWorkspaces, t } = props
  const { switchWorkspace } = props as WorkspaceSelectProps & WorkspaceSwitch
  const cwd = useSessions(s => s.byId[zone.session.sessionId]?.cwd)
  const workspaces = useWorkspaces(s => s)
  const [open, setOpen] = useState(false)

  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.chip}
        aria-label={t('workspace.select.aria')}
        aria-expanded={open || undefined}
        title={cwd ?? undefined}
        onClick={() => setOpen(v => !v)}
      >
        <span className={css.dot} aria-hidden />
        <span className={css.label}>{cwd ?? t('workspace.select.none')}</span>
      </button>
      {open && (
        <div className={css.menu} role="menu">
          {workspaces.items.map(ws => (
            <button
              key={ws.workspaceId}
              type="button"
              role="menuitem"
              className={css.item}
              title={ws.path}
              onClick={() => { setOpen(false); void switchWorkspace?.(ws.workspaceId) }}
            >
              {ws.title}
            </button>
          ))}
          {workspaces.items.length === 0 && <span className={css.empty}>{t('workspace.select.none')}</span>}
        </div>
      )}
    </div>
  )
}

// Re-export for the four-share composition and tests (same pattern as AppFrame).
export default WorkspaceSelect
