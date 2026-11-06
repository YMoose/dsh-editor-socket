export const NS = 'editorSocket'
export const en = {
  title: 'Editor context', live: 'Following', pinned: 'Pinned', pin: 'Pin reference',
  clear: 'Clear current reference', remove: 'Remove reference', reset: 'Clear all',
  unavailable: 'Editor context is unavailable. Reconnecting…',
  hint: 'Included with your next message. Changing the selection does not start a task.',
} as const
export type Key = keyof typeof en
export const zh: Record<Key, string> = {
  title: '编辑器上下文', live: '跟随中', pinned: '已固定', pin: '固定引用',
  clear: '清除当前引用', remove: '移除引用', reset: '全部清除',
  unavailable: '编辑器上下文暂不可用，正在重新连接…',
  hint: '随下一条消息发送。改变选区不会启动任务。',
}
