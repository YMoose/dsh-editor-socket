/** Browser half: a small reference rail in DSH's existing conversation composer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SocketError } from '../protocol.ts'
import { EditorDock } from './Dock.tsx'
import type { DockInjected } from './Dock.tsx'
import type { Request } from './observer.ts'
import { NS, en, zh } from './locales.ts'
import type { Key } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { editorSocket: Key }
}

export const name = 'dsh-editor-socket-client'
export const inject = ['connection', 'slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'editor-socket: locale')
  const connection = ctx.get('connection') as ConnectionHandle
  const request: Request = async (method, payload, signal) => {
    const result = await connection.rpc.call('/api', `editor-socket/${method}`, payload, signal)
    if (!result.ok) throw new SocketError(result.error.code, result.error.message)
    return result.value
  }
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'dsh-editor-socket', order: 20, locale: NS,
    inject: (sessionId): DockInjected => ({ editorSessionId: sessionId, requestEditor: request }),
  }, EditorDock))
}
