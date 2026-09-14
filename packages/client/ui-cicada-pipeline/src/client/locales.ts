/** `cicada.pipeline` namespace dictionaries (P4, 4-spec §2). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': '管线',
  'panel.empty': '暂无管线活动',
  'status.running': '进行中',
  'status.ok': '完成',
  'status.error': '失败',
  'card.aria': '管线阶段卡片：{tool}',
} satisfies Record<string, string>

/** The cicada.pipeline namespace key union. */
export type CicadaPipelineKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.title': 'Pipeline',
  'panel.empty': 'No pipeline activity yet',
  'status.running': 'Running',
  'status.ok': 'Done',
  'status.error': 'Failed',
  'card.aria': 'Pipeline stage card: {tool}',
} satisfies Record<CicadaPipelineKey, string>
