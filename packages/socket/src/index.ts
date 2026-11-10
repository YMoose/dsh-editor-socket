/** DSH Host half: authenticated editor RPC and durable, prompt-correlated model context. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { stat } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PROTOCOL_VERSION, SocketError, record, string, normalizePath, renderContext } from 'dsh-editor-protocol'
import type { EditorSnapshot } from 'dsh-editor-protocol'
import { EditorSessions } from './sessions.ts'
import { EditorStore } from './store.ts'
import { resolveConfig } from './config.ts'
import type { Config } from './config.ts'
import { startSocket, respond, METHODS, MUTATIONS, COMPOSER } from './transport.ts'
import type { Dispatch } from './transport.ts'
import { capturesProjection } from './captures.ts'

export type { Config } from './config.ts'
export const name = 'dsh-editor-socket'
export const inject = ['agents', 'workingDirectory', 'sessionProjections', 'connection']

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

/** Fail loudly when an editor connects to a directory this host cannot see. */
async function assertDirectory(workspace: string): Promise<void> {
  try {
    if (!(await stat(workspace)).isDirectory()) throw new SocketError('workspace-mismatch', 'The editor workspace must be a directory on the DSH host')
  } catch (error) {
    if (error instanceof SocketError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SocketError('workspace-mismatch', 'The editor workspace does not exist on the DSH host')
    throw error
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const limits = resolveConfig(config)
  const store = new EditorStore(limits)
  const captures = await ctx.sessionProjections.register(capturesProjection)
  const sessions = new EditorSessions(ctx)
  const directory = sessions.directory.bind(sessions)
  /** Resolve a composer session to its current working directory, if it is loaded. */
  const directoryOf = (sessionId: string): string | undefined => {
    const agent = ctx.agents.get(sessionId as SessionId)
    return agent ? directory(agent) : undefined
  }

  const dispatch: Dispatch = async (method, payload, signal) => {
    try {
      signal.throwIfAborted()
      if (method === 'info') return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, limits } }
      if (method === 'sessions') {
        return { ok: true, value: await sessions.list(signal) }
      }
      const input = record(payload)
      if (method === 'connect') {
        const request = {
          clientId: string(input.clientId, 'clientId', 256),
          editor: string(input.editor, 'editor', 80),
          workspace: normalizePath(string(input.workspace, 'workspace')),
        }
        await assertDirectory(request.workspace)
        signal.throwIfAborted()
        return { ok: true, value: store.connect(request) }
      }
      // Editor-side calls carry {workspace, connectionId, sequence} and never a session;
      // the store validates that lease itself, so no session lookup may run first.
      if (MUTATIONS.has(method)) return { ok: true, value: store.mutate(method, input) }
      if (!COMPOSER.has(method)) throw new SocketError('not-found', 'Unknown editor operation')
      // Composer-side calls know only their session; the host maps it to its live directory.
      // The mapping may be undefined for a session without a directory, which the store tolerates.
      const workspace = directoryOf(string(input.sessionId, 'sessionId', 256))
      if (method === 'state') return { ok: true, value: store.state(workspace) }
      if (method === 'watch') return { ok: true, value: await store.watch(workspace, string(input.version, 'version', 256), signal) }
      return { ok: true, value: store.edit(workspace, input) }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof SocketError) return { ok: false, error: { code: `editor-socket/${error.code}`, message: error.message, details: {} } }
      ctx.logger.warn('Editor socket request failed: %s', error instanceof Error ? error.message : String(error))
      return { ok: false, error: { code: 'editor-socket/internal', message: 'Editor socket request failed', details: {} } }
    }
  }

  // Exact native routes work through both Web HTTP and Desktop IPC. DSH enforces owner-only access.
  // The connection service is optional: minimal/headless profiles may not mount it.
  const connection = ctx.get('connection')
  if (connection) {
    for (const method of METHODS) {
      connection.fetch.register({
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
  }

  // The lease is keyed by working directory, so every session in it — including
  // ones created after the editor connected — captures the same live reference.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    store.capture(directory(agent), snapshots => {
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
