import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePath } from 'dsh-editor-protocol'
import { EditorStore } from 'dsh-editor-socket/store'
import { resolveConfig } from 'dsh-editor-socket/config'
import { CLAUDE_BRIDGE_CLIENT_ID, ClaudeSelectionBridge } from 'dsh-editor-socket/claude-bridge'
import type { ClaudeSocketHandlers } from 'dsh-editor-socket/claude'

interface FixtureOptions {
  now?(): number
  /** List the fixture workspace from a promise, like the real session-list-backed provider. */
  asyncWorkspaces?: boolean
}

interface Fixture {
  readonly bridge: ClaudeSelectionBridge
  readonly store: EditorStore
  readonly normalized: string
  readonly workspace: string
  writeLock(port?: number): Promise<string>
  handlers(): ClaudeSocketHandlers | undefined
  socketClosed(): boolean
  connects(): number
}

async function fixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-bridge-'))
  const lockRoot = join(dir, 'ide')
  const workspace = join(dir, 'work')
  await mkdir(lockRoot, { recursive: true })
  await mkdir(workspace, { recursive: true })
  const normalized = normalizePath(workspace)
  const store = new EditorStore(resolveConfig(), options.now)
  let handlers: ClaudeSocketHandlers | undefined
  let socketClosed = false
  let connects = 0
  const bridge = new ClaudeSelectionBridge({
    store,
    workspaces: options.asyncWorkspaces ? async () => [workspace] : () => [workspace],
    lockRoot,
    pollMs: 60_000,
    now: options.now,
    connectSocket: (_connection, value) => {
      connects += 1
      socketClosed = false
      handlers = value
      return { close: () => { socketClosed = true } }
    },
  })
  t.after(async () => {
    bridge.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    bridge, store, normalized, workspace,
    writeLock: async (port = 41_000) => {
      const file = join(lockRoot, `${port}.lock`)
      // A live pid keeps the stale-lock filter from discarding the fixture.
      await writeFile(file, JSON.stringify({ pid: process.pid, workspaceFolders: [workspace], transport: 'ws', authToken: 'token' }))
      return file
    },
    handlers: () => handlers,
    socketClosed: () => socketClosed,
    connects: () => connects,
  }
}

test('the bridge leases a matching workspace and forwards Claude selections', async t => {
  const f = await fixture(t)
  const lockFile = await f.writeLock()
  f.bridge.start()
  assert.equal(f.store.clientIdOf(f.normalized), CLAUDE_BRIDGE_CLIENT_ID)
  assert.equal(f.store.state(f.normalized).connected, true)
  assert.equal(f.store.state(f.normalized).editor, 'VS Code (Claude)')

  f.handlers()?.onSelection({
    text: 'abc',
    filePath: join(f.workspace, 'a.ts'),
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, isEmpty: false },
  })
  const live = f.store.state(f.normalized).live
  assert.equal(live?.path, normalizePath(join(f.workspace, 'a.ts')))
  assert.equal(live?.selection?.start, 1, 'Claude lines are shifted to the wire format')
  assert.equal(live?.selection?.text, 'abc')

  // Closing VS Code removes the lock file; the next pass releases the lease.
  await unlink(lockFile)
  await f.bridge.tick()
  assert.equal(f.socketClosed(), true)
  assert.equal(f.store.state(f.normalized).connected, false)
})

test('workspace listing may be asynchronous', async t => {
  const f = await fixture(t, { asyncWorkspaces: true })
  await f.writeLock()
  f.bridge.start()
  // The first pass awaits the provider, so let the microtask queue drain once.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.store.state(f.normalized).connected, true)
})

test('a real editor lease outranks the bridge', async t => {
  const f = await fixture(t)
  await f.writeLock()
  f.store.connect({ clientId: 'editor-window', editor: 'VS Code', workspace: f.normalized })
  f.bridge.start()
  assert.equal(f.store.clientIdOf(f.normalized), 'editor-window')
  assert.equal(f.handlers(), undefined, 'the bridge must not connect while an editor owns the workspace')
})

test('the bridge yields when a real editor takes the lease over', async t => {
  const f = await fixture(t)
  await f.writeLock()
  f.bridge.start()
  assert.equal(f.store.state(f.normalized).editor, 'VS Code (Claude)')
  // Real editors may displace a bridge lease; the bridge must notice and step aside.
  f.store.connect({ clientId: 'editor-window', editor: 'VS Code', workspace: f.normalized })
  await f.bridge.tick()
  assert.equal(f.store.clientIdOf(f.normalized), 'editor-window')
  assert.equal(f.store.state(f.normalized).editor, 'VS Code')
  assert.equal(f.socketClosed(), true)
})

test('a failed endpoint backs off before reconnecting', async t => {
  const clock = { now: 1_000 }
  const f = await fixture(t, { now: () => clock.now })
  await f.writeLock()
  f.bridge.start()
  assert.equal(f.connects(), 1)
  // The peer dropping the socket is a failure: release the lease and pause retries.
  f.handlers()?.onClose?.()
  assert.equal(f.store.state(f.normalized).connected, false)
  await f.bridge.tick()
  assert.equal(f.connects(), 1, 'a failed endpoint is not retried immediately')
  clock.now += 1_500
  await f.bridge.tick()
  assert.equal(f.connects(), 2, 'retries resume after the backoff window')
})

test('stopping the bridge releases its leases', async t => {
  const f = await fixture(t)
  await f.writeLock()
  f.bridge.start()
  assert.equal(f.store.state(f.normalized).connected, true)
  f.bridge.stop()
  assert.equal(f.store.state(f.normalized).connected, false)
})
