/** DSH Host half: authenticated editor RPC and durable, prompt-correlated model context. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PROTOCOL_VERSION, SocketError, record, string, normalizePath, renderContext } from './protocol.ts'
import type { EditorSnapshot, SessionDescriptor } from './protocol.ts'
import { EditorStore } from './store.ts'
import { resolveConfig } from './config.ts'
import type { Config } from './config.ts'
import { startSocket, respond, METHODS } from './transport.ts'
import type { Dispatch } from './transport.ts'
import { capturesProjection } from './captures.ts'

export type { Config } from './config.ts'
export const name = 'dsh-editor-socket'
export const inject = ['connection', 'agents', 'workingDirectory', 'sessionProjections']

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:editor-socket/capture': { messageId: string; snapshots: readonly EditorSnapshot[] }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Editor context is logged as ordinary user-role context before any model sees it. */
    'editor-socket': { kind: 'editor-socket' } & ContextFormed
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const limits = resolveConfig(config)
  const store = new EditorStore(limits)
  const captures = await ctx.sessionProjections.register(capturesProjection)
  const active = (sessionId: string): Agent => {
    const agent = ctx.agents.get(sessionId as SessionId)
    if (!agent) throw new SocketError('session-unavailable', 'Open this DSH session before connecting the editor')
    return agent
  }
  const directory = (agent: Agent): string => normalizePath(ctx.workingDirectory.get(agent.session))

  const dispatch: Dispatch = async (method, payload, signal) => {
    try {
      signal.throwIfAborted()
      if (method === 'info') return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, limits } }
      if (method === 'sessions') {
        const sessions: SessionDescriptor[] = ctx.agents.list().map(agent => ({
          sessionId: agent.id, directory: directory(agent), status: agent.status,
        }))
        return { ok: true, value: sessions }
      }
      const input = record(payload)
      const sessionId = string(input.sessionId, 'sessionId', 256)
      if (method === 'connect') {
        const agent = active(sessionId)
        const receipt = store.connect({
          sessionId, clientId: string(input.clientId, 'clientId', 256),
          editor: string(input.editor, 'editor', 80), workspace: string(input.workspace, 'workspace'),
        }, directory(agent))
        return { ok: true, value: receipt }
      }
      const knownDirectory = store.workspace(sessionId)
      const agent = ctx.agents.get(sessionId as SessionId)
      if (knownDirectory && (!agent || directory(agent) !== knownDirectory)) store.remove(sessionId)
      if (method === 'state') return { ok: true, value: store.state(sessionId) }
      if (method === 'watch') return { ok: true, value: await store.watch(sessionId, string(input.version, 'version', 256), signal) }
      if (method === 'edit') return { ok: true, value: store.edit(input) }
      if (!agent) throw new SocketError('session-unavailable', 'Open this DSH session before connecting the editor')
      return { ok: true, value: store.mutate(method, input) }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof SocketError) return { ok: false, error: { code: `editor-socket/${error.code}`, message: error.message, details: {} } }
      ctx.logger.warn('Editor socket request failed: %s', error instanceof Error ? error.message : String(error))
      return { ok: false, error: { code: 'editor-socket/internal', message: 'Editor socket request failed', details: {} } }
    }
  }

  // Exact native routes work through both Web HTTP and Desktop IPC. DSH enforces owner-only access.
  for (const method of METHODS) {
    ctx.connection.fetch.register({
      path: `/api/editor-socket/${method}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        try {
          const value = await respond(dispatch, method, await request.json(), request.signal)
          return Response.json(value, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (request.signal.aborted) throw error
          return new Response('Invalid editor socket request', { status: 400 })
        }
      },
    })
  }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    if (store.workspace(agent.id) !== directory(agent)) { store.remove(agent.id); return }
    store.capture(agent.id, snapshots => {
      appendPluginRecord(agent.session, 'plugin:editor-socket/capture', { messageId: message.id, snapshots })
    })
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const frozen = new Map(captures.stateOf(agent.session).captures.map(item => [item.messageId, item.snapshots]))
    const output: UserMessage[] = []
    for (const message of decision.messages) {
      output.push(message)
      const snapshots = frozen.get(message.id)
      if (!snapshots?.length) continue
      const text = renderContext(snapshots)
      output.push(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'editor-socket', form: 'snapshot', sections: [{ name: 'Editor', text }] },
      }))
    }
    return { ...decision, messages: output }
  }, { prepend: true })
  ctx.on('session/disposed', session => { store.remove(session.id) })

  ctx.effect(() => {
    const timer = setInterval(() => { store.expire() }, Math.min(limits.leaseMs / 3, 1000))
    timer.unref()
    return () => { clearInterval(timer); store.dispose() }
  }, 'editor-socket: leases and subscriptions')
  await ctx.effect(async () => {
    const socket = await startSocket(dispatch, config.discoveryDirectory, Math.max(262_144, limits.maxSelectionBytes * 6 + 32_768))
    return socket.close
  }, 'editor-socket: local editor endpoint')
}
