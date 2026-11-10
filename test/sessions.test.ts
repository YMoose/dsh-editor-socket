import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { EditorSessions } from 'dsh-editor-socket/sessions'

test('history discovery is read-only and directory-scoped; connection targets no session', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  const row = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    sessionId: SessionId(id), cwd: '/tmp', updatedAt: 1, blank: false, running: false, agentAvailable: false,
    projections: { kind: 'cached', asOfSeq: 3, values: { title: `历史会话 ${id}` } }, ...extra,
  })
  const items = [row('one'), row('two'), row('other', { cwd: '/other' }), row('child', { origin: 'subagent' }), row('no-cwd', { cwd: undefined }), row('blank', { blank: true }), row('archived')]
  ctx.provide('workspaceRegistry', { archivedSessionIds: [SessionId('archived')] } as unknown as Context['workspaceRegistry'])
  // Only the Session API boundary is doubled here; the restart smoke uses its real implementation.
  // A real controller lists live agents alongside persisted rows, so the double must too.
  ctx.provide('sessionController', {
    list: async (_input: unknown, signal: AbortSignal) => {
      signal.throwIfAborted()
      const live = ctx.agents.list().map(agent => row(agent.id, { agentAvailable: true }))
      return { items: [...items, ...live] }
    },
  } as unknown as Context['sessionController'])
  const sessions = new EditorSessions(ctx)
  const signal = new AbortController().signal

  const discovered = await sessions.list(signal)
  assert.deepEqual(discovered.map(item => item.sessionId), ['one', 'two', 'other'])
  assert.equal(discovered[0]?.title, '历史会话 one')
  assert.equal(discovered[0]?.status, 'unloaded')
  assert.equal(ctx.agents.list().length, 0, 'listing must never activate history')

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(sessions.list(aborted.signal), { name: 'AbortError' })

  // Loaded sessions report their live directory, the key every capture resolves through.
  const agent = await harness.create(SessionId('live'), {}, { cwd: '/tmp' })
  const listed = await sessions.list(signal)
  assert.equal(listed.find(item => item.sessionId === agent.id)?.directory, '/tmp')
  assert.equal(listed.find(item => item.sessionId === agent.id)?.status, agent.status)
  assert.equal(listed.filter(item => item.sessionId === agent.id).length, 1, 'live and persisted rows are not duplicated')
})
