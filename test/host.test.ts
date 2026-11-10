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
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as Socket from 'dsh-editor-socket'
import { EditorPlug } from 'dsh-editor-plug'
import type { Registration } from 'dsh-editor-socket/transport'

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

test('real DSH loop + native IPC routes + workspace-scoped editor socket', { timeout: 20_000 }, async t => {
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
  const first = await harness.create(SessionId('first'), { provider: 'mock', model: 'mock' }, { cwd: '/tmp' })
  const second = await harness.create(SessionId('second'), { provider: 'mock', model: 'mock' }, { cwd: '/tmp' })
  const elsewhere = await harness.create(SessionId('elsewhere'), { provider: 'mock', model: 'mock' }, { cwd: dir })
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === first.session || session === second.session) events.push(event) })
  const filename = join(discovery, (await readdir(discovery))[0]!)
  const registration = JSON.parse(await readFile(filename, 'utf8')) as Registration
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600)
  const plug = new EditorPlug({ url: registration.url, headers: { authorization: `Bearer ${registration.token}` } })
  t.after(() => plug.disconnect().catch(() => {}))
  assert.equal((await plug.sessions()).length, 3)
  const titles = await ctx.plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 })
  ctx.sessionTitle.rename(first.session, '编辑器上下文接入')
  assert.equal((await plug.sessions()).find(session => session.sessionId === first.id)?.title, '编辑器上下文接入')
  ctx.sessionTitle.rename(first.session, '重命名后的会话')
  const renamed = await plug.sessions()
  assert.equal(renamed.find(session => session.sessionId === first.id)?.title, '重命名后的会话')
  assert.equal(renamed.find(session => session.sessionId === second.id)?.title, undefined, 'titles are session-scoped')
  await titles.dispose()

  // Connection is directory-scoped: one lease covers every session in /tmp, present or future.
  await assert.rejects(plug.connect({ clientId: 'test-window', editor: 'VS Code', workspace: join(dir, 'missing') }), { code: 'editor-socket/workspace-mismatch' })
  await plug.connect({ clientId: 'test-window', editor: 'VS Code', workspace: '/tmp' })
  const rival = new EditorPlug({ url: registration.url, headers: { authorization: `Bearer ${registration.token}` } })
  await assert.rejects(rival.connect({ clientId: 'rival-window', editor: 'Other', workspace: '/tmp' }), { code: 'editor-socket/busy' })
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
  assert.equal((await native('state', { sessionId: first.id })).live.path, '/tmp/selected.ts')
  assert.equal((await native('state', { sessionId: second.id })).live.path, '/tmp/selected.ts', 'a sibling session in the same directory sees the same reference')
  assert.equal((await native('state', { sessionId: elsewhere.id })).live, null, 'another directory is untouched')
  assert.equal((await native('state', { sessionId: 'not-loaded' })).connected, false, 'unknown sessions report an empty state')

  const endpoint = `${registration.url}/editor-socket/state`
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${registration.token}`, origin: 'https://untrusted.example' } })).status, 403)

  // Inbox insertion freezes context for that session, before later selections and before any turn starts.
  first.inbox.append('next-step', message('explain the captured selection'))
  await plug.update(selection('later.ts'))
  assert.equal(recorder.requests.length, 0)
  await plug.clear()
  first.followup(message('run queued input'))
  await first.whenIdle()
  assert.equal(recorder.requests.length, 1, JSON.stringify(events))
  const request = JSON.stringify(recorder.requests[0]?.messages)
  assert.match(request, /unsaved selected.ts/)
  assert.doesNotMatch(request, /unsaved later.ts/)
  let injected = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket')
  assert.equal(injected.length, 1, 'context is persisted on the normal model surface')

  // The same directory lease serves a different session without any new editor connection.
  await plug.update(selection('shared.ts'))
  second.followup(message('another session in the same directory'))
  await second.whenIdle()
  assert.equal(recorder.requests.length, 2)
  assert.match(JSON.stringify(recorder.requests[1]?.messages), /unsaved shared.ts/)
  injected = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket')
  assert.equal(injected.length, 2)

  // Sessions in other directories never capture this editor's reference.
  await plug.update(selection('isolated.ts'))
  elsewhere.followup(message('session in another directory'))
  await elsewhere.whenIdle()
  assert.equal(recorder.requests.length, 3)
  assert.doesNotMatch(JSON.stringify(recorder.requests[2]?.messages), /Editor context captured/)

  // A plugin reload recovers already submitted context, even after live context is cleared.
  await plug.update(selection('later.ts'))
  second.inbox.append('next-step', message('queued before reload'))
  await plug.clear()
  assert.equal((await native('state', { sessionId: second.id })).live, null)
  await plug.disconnect()
  await socket.dispose()
  assert.deepEqual(await readdir(discovery), [])
  socket = await ctx.plugin(Socket, { discoveryDirectory: discovery })
  second.followup(message('run after reload'))
  await second.whenIdle()
  assert.equal(recorder.requests.length, 4)
  const latest = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket')
  assert.equal(latest.length, 3)
  assert.match(JSON.stringify(latest[2]), /unsaved later.ts/)
  second.followup(message('no additional editor context'))
  await second.whenIdle()
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'editor-socket').length, 3)
  await socket.dispose()
  assert.deepEqual(await readdir(discovery), [])
})
