import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { EditorSessions } from '../src/sessions.ts'
import { SocketError } from '../src/protocol.ts'

test('history discovery is read-only; only an eligible, matching, selected session is resumed', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  const row = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    sessionId: SessionId(id), cwd: '/tmp', updatedAt: 1, blank: false, running: false, agentAvailable: false,
    projections: { kind: 'cached', asOfSeq: 3, values: { title: `历史会话 ${id}` } }, ...extra,
  })
  let items = [row('one'), row('two'), row('other', { cwd: '/other' }), row('child', { origin: 'subagent' }), row('no-cwd', { cwd: undefined }), row('blank', { blank: true }), row('archived')]
  ctx.provide('workspaceRegistry', { archivedSessionIds: [SessionId('archived')] } as unknown as Context['workspaceRegistry'])
  const resumed: string[] = []
  let failResume = false
  let resumeDirectory = '/tmp'
  const controller: Pick<Context['sessionController'], 'list' | 'resolveAgent'> = {
    list: async (_input, signal) => { signal.throwIfAborted(); return { items } },
    resolveAgent: async id => {
      resumed.push(id)
      if (failResume) throw new Error('session was removed during connection')
      return { agent: await harness.create(id, {}, { cwd: resumeDirectory }) }
    },
  }
  // Only the Session API boundary is doubled here; the restart smoke uses its real implementation.
  ctx.provide('sessionController', controller as Context['sessionController'])
  const sessions = new EditorSessions(ctx)
  const signal = new AbortController().signal
  const request = { sessionId: 'one', clientId: 'editor', editor: 'VS Code', workspace: '/tmp' }
  const discovered = await sessions.list(signal)
  assert.deepEqual(discovered.map(item => item.sessionId), ['one', 'two', 'other'])
  assert.equal(discovered[0]?.title, '历史会话 one')
  assert.equal(discovered[0]?.status, 'unloaded')
  assert.equal(ctx.agents.list().length, 0)
  assert.deepEqual(resumed, [])

  const rejects = (sessionId: string, code: string) => assert.rejects(
    sessions.connect({ ...request, sessionId }, signal),
    (error: unknown) => error instanceof SocketError && error.code === code,
  )
  await rejects('other', 'workspace-mismatch')
  await rejects('child', 'session-unavailable')
  await rejects('no-cwd', 'session-unavailable')
  await rejects('blank', 'session-unavailable')
  await rejects('archived', 'session-unavailable')
  await rejects('missing', 'session-unavailable')
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(sessions.connect(request, aborted.signal), { name: 'AbortError' })
  assert.deepEqual(resumed, [], 'invalid targets and cancelled requests must not resume anything')

  items = items.filter(item => item.sessionId !== 'one')
  await rejects('one', 'session-unavailable')
  assert.deepEqual(resumed, [], 'a session removed after discovery must not be recreated')
  items.push(row('one'))
  failResume = true
  await assert.rejects(sessions.connect(request, signal), /removed during connection/)
  assert.equal(ctx.agents.list().length, 0)
  failResume = false
  const agent = await sessions.connect(request, signal)
  assert.equal(agent.id, 'one')
  assert.deepEqual(ctx.agents.list().map(item => item.id), ['one'])
  assert.equal((await sessions.list(signal)).filter(item => item.sessionId === 'one').length, 1, 'live and persisted rows are not duplicated')

  resumeDirectory = '/different'
  await rejects('two', 'workspace-mismatch')
})
