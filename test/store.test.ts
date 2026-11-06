import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorStore } from '../src/store.ts'
import { resolveConfig } from '../src/config.ts'
import { snapshotOf, normalizePath } from '../src/protocol.ts'

const snapshot = (name = 'a.ts') => ({ path: `/work/${name}`, workspace: '/work', selection: { start: 2, end: 4, text: '未保存的内容' } })
function setup(config = {}) {
  let now = 0
  const store = new EditorStore(resolveConfig(config), () => now)
  const receipt = store.connect({ sessionId: 'a', clientId: 'window', editor: 'VS Code', workspace: '/work' }, '/work')
  const mutate = (method: string, sequence: number, extra = {}) => store.mutate(method, { sessionId: 'a', connectionId: receipt.connectionId, sequence, ...extra })
  return { store, mutate, advance: () => { now += 31_000 } }
}

test('sessions isolate state; delayed packets and obsolete connections cannot replace newer selections', () => {
  const { store, mutate } = setup()
  mutate('update', 2, { snapshot: snapshot('new.ts') })
  mutate('update', 1, { snapshot: snapshot('old.ts') })
  assert.equal(store.state('a').live?.path, '/work/new.ts')
  assert.equal(store.state('b').live, null)
  assert.throws(() => store.connect({ sessionId: 'a', clientId: 'other', editor: 'Other', workspace: '/work' }, '/work'), /another editor/)
  store.connect({ sessionId: 'a', clientId: 'window', editor: 'VS Code', workspace: '/work' }, '/work')
  assert.throws(() => mutate('clear', 3), /Reconnect/)
})

test('captures freeze live selection, remain available for later sends, and clear on removal or disconnect', () => {
  const { store, mutate } = setup()
  const state = mutate('update', 1, { snapshot: snapshot() })
  const frozen = store.capture('a')
  assert.deepEqual(store.capture('a'), frozen, 'sending does not remove the live reference')
  assert.throws(() => store.capture('a', () => { throw new Error('disk full') }), /disk full/)
  assert.equal(store.state('a').version, state.version)
  mutate('update', 2, { snapshot: snapshot('next.ts') })
  assert.equal(frozen[0]?.path, '/work/a.ts')
  assert.equal(store.capture('a')[0]?.path, '/work/next.ts')
  const current = store.state('a')
  store.edit({ sessionId: 'a', version: current.version, action: 'clear' })
  assert.deepEqual(store.capture('a'), [])
  mutate('heartbeat', 3)
  assert.equal(store.state('a').live, null, 'heartbeat must not resurrect a dismissed reference')
  mutate('update', 4, { snapshot: snapshot('later.ts') })
  assert.equal(store.state('a').live?.path, '/work/later.ts', 'a new editor event resumes following')
  mutate('disconnect', 5)
  assert.deepEqual(store.capture('a'), [])
})

test('lease expiry clears context and frees capacity', () => {
  const { store, mutate, advance } = setup({ maxSessions: 1 })
  mutate('update', 1, { snapshot: snapshot() })
  advance()
  assert.equal(store.state('a').connected, false)
  assert.equal(store.state('a').live, null)
  assert.throws(() => mutate('heartbeat', 2), /Reconnect/)
  assert.doesNotThrow(() => store.connect({ sessionId: 'b', clientId: 'window', editor: 'VS Code', workspace: '/work' }, '/work'))
})

test('browser revisions protect newer selections; pin operations are rejected without changing state', () => {
  const { store, mutate } = setup()
  const stale = mutate('update', 1, { snapshot: snapshot() })
  const fresh = mutate('update', 2, { snapshot: snapshot('new.ts') })
  assert.throws(() => store.edit({ sessionId: 'a', version: stale.version, action: 'clear' }), /changed/)
  assert.throws(() => store.edit({ sessionId: 'a', version: fresh.version, action: 'pin' }), /Unknown/)
  assert.throws(() => mutate('pin', 3), /Unknown/)
  assert.equal(store.state('a').version, fresh.version)
  ;(fresh as { live: unknown }).live = null
  assert.equal(store.state('a').live?.path, '/work/new.ts', 'returned objects cannot mutate store state')
})

test('watch wakes on updates, cancels without leaking its quota, and rejects on shutdown', async () => {
  const { store, mutate } = setup({ maxWatchers: 1 })
  const watch = store.watch('a', store.state('a').version, new AbortController().signal)
  await assert.rejects(store.watch('a', store.state('a').version, new AbortController().signal), /subscriptions/)
  mutate('update', 1, { snapshot: snapshot() })
  assert.equal((await watch).live?.path, '/work/a.ts')
  const abort = new AbortController()
  const canceled = store.watch('a', store.state('a').version, abort.signal)
  abort.abort()
  await assert.rejects(canceled, { name: 'AbortError' })
  const stopped = store.watch('a', store.state('a').version, new AbortController().signal)
  store.dispose()
  await assert.rejects(stopped, /stopped/)
})

test('path, line and UTF-8 bounds reject invalid context before changing state', () => {
  const { store, mutate } = setup({ maxSelectionBytes: 4 })
  const version = store.state('a').version
  assert.throws(() => mutate('update', 1, { snapshot: snapshot('../secret') }), /workspace/)
  assert.throws(() => mutate('update', 1, { snapshot: snapshot() }), /UTF-8/)
  assert.equal(store.state('a').version, version)
  const good = { path: '/work/a', workspace: '/work', selection: { start: 1, end: 1, text: '中' } }
  mutate('update', 1, { snapshot: good })
  assert.throws(() => snapshotOf({ ...good, selection: { start: 4, end: 2 } }, '/work', store.limits), /selection.end/)
  assert.throws(() => normalizePath('relative/file'), /absolute/)
  assert.equal(normalizePath('C:\\work\\src\\..\\a.ts'), 'c:/work/a.ts')
})
