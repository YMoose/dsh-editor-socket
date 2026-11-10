import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorStore } from 'dsh-editor-socket/store'
import { resolveConfig } from 'dsh-editor-socket/config'
import { snapshotOf, normalizePath } from 'dsh-editor-protocol'

const snapshot = (name = 'a.ts') => ({ path: `/work/${name}`, workspace: '/work', selection: { start: 2, end: 4, text: '未保存的内容' } })
function setup(config = {}) {
  let now = 0
  const store = new EditorStore(resolveConfig(config), () => now)
  const receipt = store.connect({ clientId: 'window', editor: 'VS Code', workspace: '/work' })
  const mutate = (method: string, sequence: number, extra = {}) => store.mutate(method, { workspace: '/work', connectionId: receipt.connectionId, sequence, ...extra })
  return { store, mutate, advance: () => { now += 31_000 } }
}

test('workspaces isolate state; delayed packets and obsolete connections cannot replace newer selections', () => {
  const { store, mutate } = setup()
  mutate('update', 2, { snapshot: snapshot('new.ts') })
  mutate('update', 1, { snapshot: snapshot('old.ts') })
  assert.equal(store.state('/work').live?.path, '/work/new.ts')
  assert.equal(store.state('/other').live, null)
  assert.equal(store.state(undefined).live, null, 'a session without a directory never sees a reference')
  assert.throws(() => store.connect({ clientId: 'other', editor: 'Other', workspace: '/work' }), /another editor/)
  store.connect({ clientId: 'window', editor: 'VS Code', workspace: '/work' })
  assert.throws(() => mutate('clear', 3), /Reconnect/)
})

test('captures freeze the live reference of a directory and serve every session in it', () => {
  const { store, mutate } = setup()
  const state = mutate('update', 1, { snapshot: snapshot() })
  const frozen = store.capture('/work')
  assert.deepEqual(store.capture('/work'), frozen, 'sending does not remove the live reference')
  assert.throws(() => store.capture('/work', () => { throw new Error('disk full') }), /disk full/)
  assert.equal(store.state('/work').version, state.version)
  mutate('update', 2, { snapshot: snapshot('next.ts') })
  assert.equal(frozen[0]?.path, '/work/a.ts')
  assert.equal(store.capture('/work')[0]?.path, '/work/next.ts')
  assert.deepEqual(store.capture('/elsewhere'), [], 'another directory never sees this reference')
  const current = store.state('/work')
  store.edit('/work', { version: current.version, action: 'clear' })
  assert.deepEqual(store.capture('/work'), [])
  mutate('heartbeat', 3)
  assert.equal(store.state('/work').live, null, 'heartbeat must not resurrect a dismissed reference')
  mutate('update', 4, { snapshot: snapshot('later.ts') })
  assert.equal(store.state('/work').live?.path, '/work/later.ts', 'a new editor event resumes following')
  mutate('disconnect', 5)
  assert.deepEqual(store.capture('/work'), [])
})

test('lease expiry clears context and frees capacity', () => {
  const { store, mutate, advance } = setup({ maxWorkspaces: 1 })
  mutate('update', 1, { snapshot: snapshot() })
  // While leased, /work occupies the only workspace slot.
  assert.throws(() => store.connect({ clientId: 'window', editor: 'VS Code', workspace: '/other' }), /Too many/)
  advance()
  assert.equal(store.state('/work').connected, false)
  assert.equal(store.state('/work').live, null)
  assert.throws(() => mutate('heartbeat', 2), /Reconnect/)
  // Expiry discarded the lease and the entry, so the slot is free again.
  assert.doesNotThrow(() => store.connect({ clientId: 'window', editor: 'VS Code', workspace: '/work' }))
  assert.throws(() => store.connect({ clientId: 'window2', editor: 'Other', workspace: '/other' }), /Too many/)
})

test('browser revisions protect newer selections; unknown controls are rejected without changing state', () => {
  const { store, mutate } = setup()
  const stale = mutate('update', 1, { snapshot: snapshot() })
  const fresh = mutate('update', 2, { snapshot: snapshot('new.ts') })
  assert.throws(() => store.edit('/work', { version: stale.version, action: 'clear' }), /changed/)
  assert.throws(() => store.edit('/work', { version: fresh.version, action: 'pin' }), /Unknown/)
  assert.throws(() => mutate('pin', 3), /Unknown/)
  assert.equal(store.state('/work').version, fresh.version)
  ;(fresh as { live: unknown }).live = null
  assert.equal(store.state('/work').live?.path, '/work/new.ts', 'returned objects cannot mutate store state')
})

test('watch wakes on updates, cancels without leaking its quota, and rejects on shutdown', async () => {
  const { store, mutate } = setup({ maxWatchers: 1 })
  const watch = store.watch('/work', store.state('/work').version, new AbortController().signal)
  await assert.rejects(store.watch('/work', store.state('/work').version, new AbortController().signal), /subscriptions/)
  mutate('update', 1, { snapshot: snapshot() })
  assert.equal((await watch).live?.path, '/work/a.ts')
  const abort = new AbortController()
  const canceled = store.watch('/work', store.state('/work').version, abort.signal)
  abort.abort()
  await assert.rejects(canceled, { name: 'AbortError' })
  const stopped = store.watch('/work', store.state('/work').version, new AbortController().signal)
  store.dispose()
  await assert.rejects(stopped, /stopped/)
})

test('path, line and UTF-8 bounds reject invalid context before changing state', () => {
  const { store, mutate } = setup({ maxSelectionBytes: 4 })
  const version = store.state('/work').version
  assert.throws(() => mutate('update', 1, { snapshot: snapshot('../secret') }), /workspace/)
  assert.throws(() => mutate('update', 1, { snapshot: snapshot() }), /UTF-8/)
  assert.equal(store.state('/work').version, version)
  const good = { path: '/work/a', workspace: '/work', selection: { start: 1, end: 1, text: '中' } }
  mutate('update', 1, { snapshot: good })
  assert.throws(() => snapshotOf({ ...good, selection: { start: 4, end: 2 } }, '/work', store.limits), /selection.end/)
  assert.throws(() => normalizePath('relative/file'), /absolute/)
  assert.equal(normalizePath('C:\\work\\src\\..\\a.ts'), 'c:/work/a.ts')
})
