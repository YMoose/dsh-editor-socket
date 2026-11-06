/** Discover persisted sessions without activating them; resume only an explicit connection target. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { normalizePath, SocketError } from './protocol.ts'
import type { ConnectRequest, SessionDescriptor } from './protocol.ts'

export class EditorSessions {
  constructor(private readonly ctx: Context) {}

  directory(agent: Agent): string { return normalizePath(this.ctx.workingDirectory.get(agent.session)) }

  async list(signal: AbortSignal): Promise<SessionDescriptor[]> {
    signal.throwIfAborted()
    const controller = this.ctx.get('sessionController')
    // Minimal/headless hosts may not mount the Web/Desktop session API.
    if (!controller) return this.ctx.agents.list().map(agent => this.live(agent))
    const { items } = await controller.list({}, signal)
    signal.throwIfAborted()
    const archived = new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    return items.flatMap(item => {
      // DSH owns subagent delivery; its ordinary-session resolver cannot resume these.
      if (item.origin === 'subagent' || !item.cwd || archived.has(item.sessionId)) return []
      const agent = this.ctx.agents.get(item.sessionId)
      if (agent) return [this.live(agent)]
      // Old unused New Session placeholders are hidden by DSH's sidebar too.
      // Keep live blanks connectable so users can attach before their first prompt.
      if (item.blank) return []
      const title = item.projections?.values.title
      const directory = item.projections?.values.workingDirectory ?? item.cwd
      return [{ sessionId: item.sessionId, directory: normalizePath(directory), status: 'unloaded',
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
      }]
    })
  }

  async connect(request: ConnectRequest, signal: AbortSignal): Promise<Agent> {
    const selected = (await this.list(signal)).find(item => item.sessionId === request.sessionId)
    if (!selected) throw new SocketError('session-unavailable', 'This DSH session is no longer available; refresh the session list')
    const workspace = normalizePath(request.workspace)
    if (selected.directory !== workspace) throw new SocketError('workspace-mismatch', 'Editor and session directories must match exactly')
    signal.throwIfAborted()
    const controller = this.ctx.get('sessionController')
    let agent: Agent | undefined
    if (controller) {
      const result = await controller.resolveAgent(request.sessionId as SessionId)
      if ('error' in result) throw new SocketError('session-unavailable', result.error.message)
      agent = result.agent
    } else {
      agent = this.ctx.agents.get(request.sessionId as SessionId)
    }
    signal.throwIfAborted()
    if (!agent) throw new SocketError('session-unavailable', 'Open this DSH session before connecting the editor')
    // The working directory may have changed since discovery or during resume.
    if (this.directory(agent) !== workspace) throw new SocketError('workspace-mismatch', 'Editor and session directories must match exactly')
    return agent
  }

  private live(agent: Agent): SessionDescriptor {
    const title = this.ctx.sessionProjections.snapshot(agent.session, ['title']).values.title
    return { sessionId: agent.id, directory: this.directory(agent), status: agent.status,
      ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    }
  }
}
