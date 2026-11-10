export const NS = 'editorSocket'
export const en = {
  title: 'Editor context', clear: 'Clear current reference',
  clearHint: 'Remove this reference. Selecting another file or range will resume following.',
  unavailable: 'Editor context is unavailable. Reconnecting…',
  hint: 'Follows your editor and is included with your next message. Changing the selection does not start a task.',
} as const
export type Key = keyof typeof en
export const zh: Record<Key, string> = {
  title: '编辑器上下文', clear: '清除当前引用',
  clearHint: '移除此引用。切换文件或选区后会恢复跟随。',
  unavailable: '编辑器上下文暂不可用，正在重新连接…',
  hint: '跟随编辑器，随下一条消息发送。改变选区不会启动任务。',
}
