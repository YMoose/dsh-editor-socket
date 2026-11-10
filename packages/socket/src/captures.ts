/** Incremental, host-only recovery of context attached to pending user messages. */
import { z } from 'zod'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'

const snapshot = z.object({
  path: z.string(), workspace: z.string(),
  selection: z.object({ start: z.number().int().positive(), end: z.number().int().positive(), text: z.string().optional() }).optional(),
})
const capture = z.object({ messageId: z.string(), snapshots: z.array(snapshot) })
const schema = z.object({
  captures: z.array(capture),
  'next-turn': z.array(z.string()),
  'next-step': z.array(z.string()),
})
type State = z.infer<typeof schema>

export const capturesProjection: ProjectionDefinition<'editor-socket/captures', State> = {
  key: 'editor-socket/captures', stateVersion: 1, stateSchema: schema,
  init: () => ({ captures: [], 'next-turn': [], 'next-step': [] }),
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record?.type === 'plugin:editor-socket/capture') {
      const parsed = capture.safeParse(record.data)
      if (!parsed.success) return state
      return { ...state, captures: [...state.captures.filter(item => item.messageId !== parsed.data.messageId), parsed.data] }
    }
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount, inserted, outcome } = event.data
      const queue = [...state[target]]
      const removed = queue.splice(start, removedCount ?? 0, ...inserted.map(message => message.id))
      return { ...state, [target]: queue, captures: outcome === 'canceled'
        ? state.captures.filter(item => !removed.includes(item.messageId)) : state.captures }
    }
    if (event.type === 'user/message') {
      return { ...state, captures: state.captures.filter(item => item.messageId !== event.data.id) }
    }
    if (event.type === 'turn/end') {
      const pending = new Set([...state['next-turn'], ...state['next-step']])
      return { ...state, captures: state.captures.filter(item => pending.has(item.messageId)) }
    }
    return state
  },
}
