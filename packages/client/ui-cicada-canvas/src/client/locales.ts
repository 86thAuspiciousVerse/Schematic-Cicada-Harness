/** `cicada.canvas` namespace dictionaries (P4, 4-spec §2). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tool.select': '选择',
  'tool.wire': '画线',
  'tool.fit': '适应视图',
  'tool.place': '放置',
  'undo': '撤销',
  'delete': '删除',
  'refresh': '刷新',
  'place.confirm': '放置',
  'locked': 'AI 正在修改原理图…',
  'menu.addContext': '加入到上下文',
  'menu.clear': '清除选择',
  'status.wireHint': '画线：左键逐点（45°吸附）· 空格/回车结束 · Esc 取消',
  'status.wireDone': '画线完成',
  'status.wireFewPoints': '画线至少需要 2 个点',
  'status.placeHint': '放置：左键点画布落位 · Esc 返回选择',
  'mirror.aria': '画布选中镜像',
  'mirror.placeholder': '在画布上选择图元以查看选中内容',
  'mirror.selected': '已选中 {count} 个图元',
} satisfies Record<string, string>

/** The cicada.canvas namespace key union. */
export type CicadaCanvasKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'tool.select': 'Select',
  'tool.wire': 'Wire',
  'tool.fit': 'Fit view',
  'tool.place': 'Place',
  'undo': 'Undo',
  'delete': 'Delete',
  'refresh': 'Refresh',
  'place.confirm': 'Place',
  'locked': 'AI is editing the schematic…',
  'menu.addContext': 'Add to context',
  'menu.clear': 'Clear selection',
  'status.wireHint': 'Wire: left-click vertices (45° snap) · Space/Enter finish · Esc cancel',
  'status.wireDone': 'Wire drawn',
  'status.wireFewPoints': 'A wire needs at least 2 points',
  'status.placeHint': 'Place: left-click the canvas · Esc returns to select',
  'mirror.aria': 'Canvas selection mirror',
  'mirror.placeholder': 'Select items on the canvas to see them here',
  'mirror.selected': 'Selected {count} items',
} satisfies Record<CicadaCanvasKey, string>
