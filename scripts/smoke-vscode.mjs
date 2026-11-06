/** Exercise a built VS Code adapter against the real DSH loop, with no model API calls. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as Socket from '../lib/index.js'
import { discoverSockets } from '../lib/discovery.js'

if (!process.argv[2]) throw new Error('Pass the compiled vsc-agents-connector/out/src/agents/dsh/index.js path')
const { createDshAdapter } = await import(pathToFileURL(resolve(process.argv[2])).href)
const dir = await mkdtemp(join(tmpdir(), 'dsh-vscode-smoke-'))
const ctx = new Context()
let adapter
let session
class Recorder extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(Connection)
  const discoveryDirectory = join(dir, 'discovery')
  await ctx.plugin(Socket, { discoveryDirectory })
  const recorder = new Recorder()
  ctx.llm.registerAdapter(['mock'], recorder)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('vscode-smoke'), { provider: 'mock', model: 'mock' }, { cwd: dir })
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 })
  ctx.sessionTitle.rename(agent.session, 'VS Code 会话标题验证')
  adapter = createDshAdapter({ discover: () => discoverSockets(discoveryDirectory) })
  const groups = await adapter.discoverSessions(dir)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].sessions[0].title, 'VS Code 会话标题验证')
  ctx.sessionTitle.rename(agent.session, '重命名后的 VS Code 会话')
  assert.equal((await adapter.discoverSessions(dir))[0].sessions[0].title, '重命名后的 VS Code 会话')
  session = { agentId: 'dsh', sessionID: agent.id, url: groups[0].url, header: groups[0].header, directory: dir }
  await adapter.connect(session)
  await adapter.liveFollow.update(session, {
    fsPath: join(dir, 'example.ts'), relativePath: 'example.ts', workspaceFolder: dir,
    selection: { start: 3, end: 8, text: 'UNSAVED_VSCODE_SELECTION' },
  })
  assert.equal(recorder.requests.length, 0)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain the selection' }] }))
  await agent.whenIdle()
  assert.equal(recorder.requests.length, 1)
  assert.match(JSON.stringify(recorder.requests[0].messages), /UNSAVED_VSCODE_SELECTION/)
  console.log('PASS: compiled VS Code adapter → local socket → real DSH AgentLoop → captured model context')
} finally {
  if (session) await adapter.disconnect(session).catch(() => {})
  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}
