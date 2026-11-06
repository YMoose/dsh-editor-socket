/** Loaded only by smoke-history.mjs inside a temporary DSH profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { discoverSockets } from '../lib/discovery.js'
import { EditorPlug } from '../lib/plug.js'

export const name = 'editor-history-fixture'
export const inject = ['llm', 'agents', 'agentLoop', 'sessionTitle', 'sessionController', 'workspaceRegistry']

export async function apply(ctx, { root, phase, adapterPath }) {
  const workspace = join(root, 'workspace')
  const discovery = join(root, 'state/dsh-editor-socket')
  const records = []
  class Recorder extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: 'History regression recorder' } }
    async *stream(options) {
      records.push(options.messages)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['editor-history'], new Recorder())
  const message = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  try {
    if (phase === 'seed') {
      const ids = Array.from({ length: 6 }, (_, i) => `editor-history-${i}`)
      for (const id of [...ids, 'editor-history-other-workspace', 'editor-history-archived']) {
        const cwd = id.endsWith('other-workspace') ? join(root, 'other') : workspace
        const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'editor-history', model: 'recorder' }, { cwd })
        ctx.sessionTitle.rename(agent.session, `历史会话 ${id}`)
        agent.followup(message('Initialize persisted history regression'))
        await agent.whenIdle()
      }
      await ctx.workspaceRegistry.archiveSession(SessionId('editor-history-archived'))
      await ctx.agentLoop.create(SessionId('editor-history-unused-blank'), { provider: 'editor-history', model: 'recorder' }, { cwd: workspace })
      await writeFile(join(root, 'history.json'), JSON.stringify(ids))
      await writeFile(join(root, 'seed-result.json'), JSON.stringify({ ok: true, sessions: ids.length }))
      return
    }

    const ids = JSON.parse(await readFile(join(root, 'history.json'), 'utf8'))
    assert.equal(ctx.agents.list().length, 0, 'a fresh host must start without the seeded agents')
    let registrations = []
    for (let attempt = 0; attempt < 100 && registrations.length === 0; attempt++) {
      registrations = await discoverSockets(discovery)
      if (!registrations.length) await delay(100)
    }
    assert.equal(registrations.length, 1, 'the test must use its own socket registration')
    const { createDshAdapter } = await import(pathToFileURL(adapterPath).href)
    const adapter = createDshAdapter({ discover: () => discoverSockets(discovery) })
    let connected
    try {
      const groups = await adapter.discoverSessions(workspace)
      assert.equal(groups.length, 1)
      assert.deepEqual(groups[0].sessions.map(s => s.id).sort(), [...ids].sort())
      assert.ok(groups[0].sessions.every(s => s.title === `历史会话 ${s.id}`), 'titles survive the real host restart')
      assert.equal(ctx.agents.list().length, 0, 'listing must not activate history')
      assert.equal(records.length, 0, 'listing must not invoke a model')

      const registration = registrations[0]
      const plug = new EditorPlug({ url: registration.url, headers: { authorization: `Bearer ${registration.token}` } })
      const request = { clientId: 'invalid-target-test', editor: 'VS Code', workspace }
      await assert.rejects(plug.connect({ ...request, sessionId: 'editor-history-other-workspace' }), { code: 'editor-socket/workspace-mismatch' })
      await assert.rejects(plug.connect({ ...request, sessionId: 'missing-history' }), { code: 'editor-socket/session-unavailable' })
      await assert.rejects(plug.connect({ ...request, sessionId: 'editor-history-unused-blank' }), { code: 'editor-socket/session-unavailable' })
      await assert.rejects(plug.connect({ ...request, sessionId: 'editor-history-archived' }), { code: 'editor-socket/session-unavailable' })
      assert.equal(ctx.agents.list().length, 0, 'rejected targets must not activate an agent')

      connected = { agentId: 'dsh', sessionID: ids[3], directory: workspace, url: groups[0].url, header: groups[0].header }
      await adapter.connect(connected)
      assert.deepEqual(ctx.agents.list().map(agent => agent.id), [ids[3]], 'only the selected history is resumed')
      await adapter.liveFollow.update(connected, {
        fsPath: join(workspace, 'sample.ts'), relativePath: 'sample.ts', workspaceFolder: workspace,
        selection: { start: 1, end: 2, text: 'HISTORY_RESUMED_SELECTION' },
      })
      assert.equal(records.length, 0, 'connecting and editor updates must not submit a prompt')
      const refreshed = await adapter.discoverSessions(workspace)
      assert.equal(refreshed[0].sessions.length, 6, 'resuming must not duplicate or hide a session')

      const selected = ctx.agents.get(SessionId(ids[3]))
      selected.followup(message('Explain the resumed editor selection'))
      await selected.whenIdle()
      assert.equal(records.length, 1)
      assert.match(JSON.stringify(records[0]), /HISTORY_RESUMED_SELECTION/)
      await writeFile(join(root, 'verify-result.json'), JSON.stringify({
        ok: true, historyListed: 6, loadedAfterDiscovery: 0, loadedAfterConnect: 1,
        modelRequestsBeforeSend: 0, capturedOnExplicitSend: true,
      }))
    } finally {
      if (connected) await adapter.disconnect(connected)
    }
  } catch (error) {
    await writeFile(join(root, `${phase}-result.json`), JSON.stringify({ ok: false, error: error.stack ?? String(error) }))
  }
}
