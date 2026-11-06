import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as Socket from '../src/index.ts'
import { EditorPlug } from '../src/plug.ts'
import type { Registration } from '../src/transport.ts'

class Recorder extends LlmAdapter {
  requests: GenerateOptions[] = []
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const selection = (name = 'selected.ts') => ({ path: `/tmp/${name}`, workspace: '/tmp', selection: { start: 3, end: 7, text: `unsaved ${name}` } })

test('real DSH loop + native IPC routes + authenticated editor socket', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'editor-socket-test-'))
  const discovery = join(dir, 'discovery')
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(Connection)
  const recorder = new Recorder()
  ctx.llm.registerAdapter(['mock'], recorder)
  let socket = await ctx.plugin(Socket, { discoveryDirectory: discovery })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('editor-test'), { provider: 'mock', model: 'mock' }, { cwd: '/tmp' })
  const other = await harness.create(SessionId('other'), { provider: 'mock', model: 'mock' }, { cwd: '/tmp' })
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  const filename = join(discovery, (await readdir(discovery))[0]!)
  const registration = JSON.parse(await readFile(filename, 'utf8')) as Registration
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600)
  const plug = new EditorPlug({ url: registration.url, headers: { authorization: `Bearer ${registration.token}` } })
  t.after(() => plug.disconnect().catch(() => {}))
  assert.equal((await plug.sessions()).length, 2)
  await plug.connect({ sessionId: agent.id, clientId: 'test-window', editor: 'VS Code', workspace: '/tmp' })
  await plug.update(selection())
  assert.equal(recorder.requests.length, 0, 'editor updates must not start a model task')

  // No webServer exists: this is the same carrier-neutral route Desktop IPC uses.
  assert.equal(ctx.get('webServer'), undefined)
  const connection = ctx.connection as Connection.HostConnectionService
  const handler = connection.createSharedFetchHandler('/api')
  const native = async (method: string, payload: object) => {
    const request = new Request(`http://localhost/api/editor-socket/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: `editor-socket/${method}`, payload }),
    })
    const response = await handler.fetch(request, connection.browserPeer)
    assert.equal(response.status, 200)
    return (await response.json()).result.value
  }
  assert.equal((await native('state', { sessionId: agent.id })).live.path, '/tmp/selected.ts')
  assert.equal((await native('state', { sessionId: other.id })).live, null)

  const endpoint = `${registration.url}/editor-socket/state`
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${registration.token}`, origin: 'https://untrusted.example' } })).status, 403)

  // Inbox insertion freezes context, before later selections and before any turn starts.
  agent.inbox.append('next-step', message('explain the captured selection'))
  await plug.update(selection('later.ts'))
  assert.equal(recorder.requests.length, 0)
  await plug.clear()
  agent.followup(message('run queued input'))
  await agent.whenIdle()
  assert.equal(recorder.requests.length, 1, JSON.stringify(events))
  const request = JSON.stringify(recorder.requests[0]?.messages)
  assert.match(request, /unsaved selected.ts/)
  assert.doesNotMatch(request, /unsaved later.ts/)
  const injected = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket')
  assert.equal(injected.length, 1, 'context is persisted on the normal model surface')

  // Pins are one-shot, and a plugin reload recovers already submitted context from the log.
  await plug.pin(selection('later.ts'))
  agent.inbox.append('next-step', message('queued before reload'))
  assert.equal((await native('state', { sessionId: agent.id })).pinned.length, 0)
  await plug.disconnect()
  await socket.dispose()
  assert.deepEqual(await readdir(discovery), [])
  socket = await ctx.plugin(Socket, { discoveryDirectory: discovery })
  agent.followup(message('run after reload'))
  await agent.whenIdle()
  assert.equal(recorder.requests.length, 2)
  const latest = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket')
  assert.equal(latest.length, 2)
  assert.match(JSON.stringify(latest[1]), /unsaved later.ts/)
  agent.followup(message('no additional editor context'))
  await agent.whenIdle()
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket').length, 2)
  other.followup(message('other session'))
  await other.whenIdle()
  assert.doesNotMatch(JSON.stringify(recorder.requests.at(-1)?.messages), /Editor context captured/)
  await socket.dispose()
  assert.deepEqual(await readdir(discovery), [])
})
