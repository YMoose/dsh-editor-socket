import { randomUUID } from 'node:crypto'
import { SocketError, normalizePath, snapshotOf, string, integer, record } from './protocol.ts'
import type { ConnectRequest, ConnectionReceipt, EditorSnapshot, EditorState, ProtocolLimits } from './protocol.ts'

interface Entry {
  workspace: string
  version: string
  lease?: { id: string; clientId: string; editor: string; sequence: number; expires: number }
  live: EditorSnapshot | null
}

/** Owns transient editor state, independently of model activity and persistent Session history. */
export class EditorStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly epoch = randomUUID()
  private revision = 0
  private watcherCount = 0
  private disposed = false

  constructor(readonly limits: ProtocolLimits, private readonly now: () => number = Date.now) {}

  connect(input: ConnectRequest, directory: string): ConnectionReceipt {
    this.assertOpen()
    const workspace = normalizePath(input.workspace)
    if (workspace !== normalizePath(directory)) throw new SocketError('workspace-mismatch', 'Editor and session directories must match exactly')
    this.expire()
    let entry = this.entries.get(input.sessionId)
    if (entry?.lease && entry.lease.clientId !== input.clientId) throw new SocketError('busy', 'This session is connected to another editor window')
    if (!entry) {
      if (this.entries.size >= this.limits.maxSessions) throw new SocketError('capacity', 'Too many connected editor sessions')
      entry = { workspace, version: this.version(), live: null }
      this.entries.set(input.sessionId, entry)
    }
    if (entry.workspace !== workspace) throw new SocketError('workspace-mismatch', 'Clear this session before connecting a different workspace')
    const connectionId = randomUUID()
    entry.lease = { id: connectionId, clientId: input.clientId, editor: input.editor, sequence: 0, expires: this.now() + this.limits.leaseMs }
    entry.live = null
    this.changed(input.sessionId, entry)
    return { connectionId, heartbeatMs: Math.floor(this.limits.leaseMs / 3), state: this.state(input.sessionId) }
  }

  mutate(method: string, payload: unknown): EditorState {
    this.assertOpen()
    const input = record(payload)
    const sessionId = string(input.sessionId, 'sessionId', 256)
    const connectionId = string(input.connectionId, 'connectionId', 256)
    const sequence = integer(input.sequence, 'sequence')
    this.expire()
    const entry = this.entries.get(sessionId)
    if (!entry?.lease || entry.lease.id !== connectionId) throw new SocketError('disconnected', 'Reconnect the editor before sending updates')
    if (sequence <= entry.lease.sequence) return this.state(sessionId)
    // Validate the complete command before changing its sequence or renewing its lease.
    if (method === 'update') {
      entry.live = snapshotOf(input.snapshot, entry.workspace, this.limits)
    } else if (method === 'clear' || method === 'disconnect') {
      entry.live = null
    } else if (method !== 'heartbeat') throw new SocketError('not-found', 'Unknown editor operation')
    entry.lease.sequence = sequence
    entry.lease.expires = this.now() + this.limits.leaseMs
    if (method === 'disconnect') delete entry.lease
    if (method !== 'heartbeat') this.changed(sessionId, entry)
    return this.state(sessionId)
  }

  /** Browser-side controls guard the revision the user actually saw. */
  edit(payload: unknown): EditorState {
    const input = record(payload)
    const sessionId = string(input.sessionId, 'sessionId', 256)
    this.expire()
    const entry = this.entries.get(sessionId)
    if (!entry || entry.version !== input.version) throw new SocketError('conflict', 'Editor context changed; try again')
    if (input.action !== 'clear') throw new SocketError('invalid', 'Unknown editor control')
    entry.live = null
    this.changed(sessionId, entry)
    return this.state(sessionId)
  }

  state(sessionId: string): EditorState {
    this.expire()
    const entry = this.entries.get(sessionId)
    return structuredClone({
      sessionId, version: entry?.version ?? `${this.epoch}:empty`,
      connected: !!entry?.lease, editor: entry?.lease?.editor ?? null,
      live: entry?.live ?? null,
    })
  }

  /** Freeze exactly one user's context; later editor changes cannot alter this capture. */
  capture(sessionId: string, commit?: (snapshots: readonly EditorSnapshot[]) => void): readonly EditorSnapshot[] {
    this.expire()
    const entry = this.entries.get(sessionId)
    if (!entry) return []
    const result = structuredClone(entry.live ? [entry.live] : [])
    if (result.length) commit?.(result)
    return result
  }

  /** Long polling has no idle polling traffic; updates wake every observing browser. */
  async watch(sessionId: string, version: string, signal: AbortSignal): Promise<EditorState> {
    this.assertOpen()
    signal.throwIfAborted()
    const initial = this.state(sessionId)
    if (initial.version !== version) return initial
    if (this.watcherCount >= this.limits.maxWatchers) throw new SocketError('capacity', 'Too many editor subscriptions')
    await new Promise<void>((resolve, reject) => {
      const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
      this.listeners.set(sessionId, listeners)
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        listeners.delete(done)
        if (!listeners.size) this.listeners.delete(sessionId)
        this.watcherCount--
      }
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal.reason) }
      const timer = setTimeout(done, this.limits.watchMs)
      listeners.add(done)
      this.watcherCount++
      signal.addEventListener('abort', abort, { once: true })
    })
    this.assertOpen()
    return this.state(sessionId)
  }

  expire(): void {
    for (const [id, entry] of this.entries) {
      if (entry.lease && entry.lease.expires <= this.now()) {
        delete entry.lease
        entry.live = null
        this.changed(id, entry)
      }
    }
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId)
    this.notify(sessionId)
  }

  workspace(sessionId: string): string | undefined { return this.entries.get(sessionId)?.workspace }

  dispose(): void {
    this.disposed = true
    this.entries.clear()
    for (const id of [...this.listeners.keys()]) this.notify(id)
  }

  private changed(sessionId: string, entry: Entry): void {
    entry.version = this.version()
    if (!entry.lease && !entry.live) this.entries.delete(sessionId)
    this.notify(sessionId)
  }
  private notify(sessionId: string): void { for (const listener of [...this.listeners.get(sessionId) ?? []]) listener() }
  private version(): string { return `${this.epoch}:${++this.revision}` }
  private assertOpen(): void { if (this.disposed) throw new SocketError('closed', 'Editor socket has stopped') }
}
