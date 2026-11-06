/** Test-only DSH plugin: real AgentLoop, deterministic model, no provider HTTP calls. */
import { randomUUID } from 'node:crypto'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'editor-gui-fixture'
export const inject = ['llm', 'agentLoop']

export async function apply(ctx, { workspace, output }) {
  class Recorder extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: 'GUI context recorder' } }
    async *stream(options) {
      // Record only user-role context, not provider credentials or system instructions.
      const messages = options.messages.filter(message => message.role === 'user')
      await appendFile(join(output, 'model-requests.jsonl'), JSON.stringify({ messages }) + '\n')
      const text = 'GUI context recorder: message received. Editor context captured in the local test log.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 15 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['editor-gui'], new Recorder())
  // Restarting a run must not collide with its already persisted previous session.
  const id = SessionId(`editor-gui-${randomUUID()}`)
  const agent = await ctx.agentLoop.create(id, { provider: 'editor-gui', model: 'recorder' }, { cwd: workspace })
  await writeFile(join(output, 'session.json'), JSON.stringify({ sessionId: id, directory: workspace }))
  // An entirely empty Agent can be absent from the normal sidebar list.
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Initialize editor GUI test session' }] }))
  await agent.whenIdle()
}
