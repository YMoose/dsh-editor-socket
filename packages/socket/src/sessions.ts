/** Discover persisted sessions without activating them; connection is directory-scoped and resumes nothing. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title/types'
import { normalizePath } from 'dsh-editor-protocol'
import type { SessionDescriptor } from 'dsh-editor-protocol'

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
      // Discovery is display-only; subagent rows are not editor targets.
      if (item.origin === 'subagent' || !item.cwd || archived.has(item.sessionId)) return []
      const agent = this.ctx.agents.get(item.sessionId)
      if (agent) return [this.live(agent)]
      // Old unused New Session placeholders are hidden by DSH's sidebar too.
      // Keep live blanks listed so users can attach before their first prompt.
      if (item.blank) return []
      const title = item.projections?.values.title
      const directory = item.projections?.values.workingDirectory ?? item.cwd
      return [{ sessionId: item.sessionId, directory: normalizePath(directory), status: 'unloaded',
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
      }]
    })
  }

  private live(agent: Agent): SessionDescriptor {
    const title = this.ctx.sessionProjections.snapshot(agent.session, ['title']).values.title
    return { sessionId: agent.id, directory: this.directory(agent), status: agent.status,
      ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    }
  }
}
