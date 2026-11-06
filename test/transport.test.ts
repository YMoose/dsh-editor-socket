import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, symlink, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startSocket } from '../src/transport.ts'
import { discoverSockets } from '../src/discovery.ts'
import { EditorPlug } from '../src/plug.ts'
import { EditorStore } from '../src/store.ts'
import { resolveConfig } from '../src/config.ts'

test('discovery validates owner-only loopback registrations; transport bounds and authenticates requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'editor-discovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const socket = await startSocket(async () => ({ ok: true, value: {} }), directory, 1024)
  t.after(socket.close)
  const { registration } = socket
  const bogus = join(directory, `${randomUUID()}.json`)
  await writeFile(bogus, 'null', { mode: 0o600 })
  const foreign = { ...registration, instanceId: randomUUID(), url: 'https://example.org' }
  await writeFile(join(directory, `${foreign.instanceId}.json`), JSON.stringify(foreign), { mode: 0o600 })
  await symlink(socket.filename, join(directory, `${randomUUID()}.json`))
  assert.deepEqual(await discoverSockets(directory), [registration])
  const request = (body: string, headers = {}) => fetch(`${registration.url}/editor-socket/info`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${registration.token}`, ...headers }, body,
  })
  assert.equal((await request('{')).status, 400)
  assert.equal((await request(JSON.stringify({ type: 'client-request', rpcId: 'a', method: 'other', payload: {} }))).status, 400)
  assert.equal((await request('x'.repeat(2048))).status, 413)
  assert.equal((await request('{}', { authorization: 'Bearer wrong' })).status, 401)
  if (process.platform !== 'win32') {
    await chmod(socket.filename, 0o644)
    assert.deepEqual(await discoverSockets(directory), [])
  }
  await socket.close()
  await assert.rejects(readFile(socket.filename), { code: 'ENOENT' })
})

test('plug serializes updates and pins, freezes caller data, and closes before accepting new edits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'editor-plug-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new EditorStore(resolveConfig())
  const socket = await startSocket(async (method, input) => {
    if (method === 'info') return { ok: true, value: { protocolVersion: 1 } }
    if (method === 'connect') return { ok: true, value: store.connect(input as Parameters<EditorStore['connect']>[0], '/tmp') }
    return { ok: true, value: store.mutate(method, input) }
  }, directory)
  t.after(socket.close)
  const plug = new EditorPlug({ url: socket.registration.url, headers: { authorization: `Bearer ${socket.registration.token}` } })
  const connecting = plug.connect({ sessionId: 's', clientId: 'window', editor: 'VS Code', workspace: '/tmp' })
  await assert.rejects(plug.connect({ sessionId: 's', clientId: 'window', editor: 'VS Code', workspace: '/tmp' }), /Disconnect/)
  await connecting
  const snapshot = { path: '/tmp/a.ts', workspace: '/tmp' }
  const update = plug.update(snapshot)
  snapshot.path = '/tmp/mutated.ts'
  const pin = plug.pin()
  const disconnect = plug.disconnect()
  await assert.rejects(plug.clear(), /not connected/)
  await Promise.all([update, pin, disconnect])
  assert.equal(store.state('s').pinned[0]?.snapshot.path, '/tmp/a.ts')
  assert.equal(store.state('s').connected, false)
})
