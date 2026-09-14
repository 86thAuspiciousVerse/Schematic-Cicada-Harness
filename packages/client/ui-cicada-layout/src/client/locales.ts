/** `cicada.layout` namespace dictionaries (P4, 4-spec §2; M1c canvas keys). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'brand.localBuild': 'Cicada Schematic',
  'pipeline.aria': '管线侧边栏：任务阶段卡片流',
  'workspace.select.aria': '当前工作区，点击切换',
  'workspace.select.none': '(无工作区)',
  'workspace.divider.aria': '拖拽调整画布宽度',
  'workspace.sidebar.divider.aria': '拖拽调整侧栏宽度',
  'canvas.aria': '原理图画布',
} satisfies Record<string, string>

/** The cicada.layout namespace key union. */
export type CicadaLayoutKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'brand.localBuild': 'Cicada Schematic',
  'pipeline.aria': 'Pipeline sidebar: task stage cards',
  'workspace.select.aria': 'Current workspace; click to switch',
  'workspace.select.none': '(no workspace)',
  'workspace.divider.aria': 'Drag to resize the canvas width',
  'workspace.sidebar.divider.aria': 'Drag to resize the sidebar width',
  'canvas.aria': 'Schematic canvas',
} satisfies Record<CicadaLayoutKey, string>
