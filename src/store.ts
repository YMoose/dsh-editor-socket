import { randomUUID } from 'node:crypto'
import { SocketError, normalizePath, snapshotOf, string, integer, record } from './protocol.ts'
import type { ConnectRequest, ConnectionReceipt, EditorSnapshot, EditorState, ProtocolLimits } from './protocol.ts'

interface Entry {
  workspace: string
  version: string
  lease?: { id: string; clientId: string; editor: string; sequence: number; expires: number }
  live: EditorSnapshot | null
}

/** Owns transient editor state per working directory, shared by every session in it. */
export class EditorStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly epoch = randomUUID()
  private revision = 0
  private watcherCount = 0
  private disposed = false

  constructor(readonly limits: ProtocolLimits, private readonly now: () => number = Date.now) {}

  connect(input: ConnectRequest): ConnectionReceipt {
    this.assertOpen()
    const workspace = normalizePath(input.workspace)
    this.expire()
    let entry = this.entries.get(workspace)
    if (entry?.lease && entry.lease.clientId !== input.clientId) throw new SocketError('busy', 'This workspace is connected to another editor window')
    if (!entry) {
      if (this.entries.size >= this.limits.maxWorkspaces) throw new SocketError('capacity', 'Too many connected workspaces')
      entry = { workspace, version: this.version(), live: null }
      this.entries.set(workspace, entry)
    }
    const connectionId = randomUUID()
    entry.lease = { id: connectionId, clientId: input.clientId, editor: input.editor, sequence: 0, expires: this.now() + this.limits.leaseMs }
    entry.live = null
    this.changed(workspace, entry)
    return { connectionId, heartbeatMs: Math.floor(this.limits.leaseMs / 3), state: this.state(workspace) }
  }

  mutate(method: string, payload: unknown): EditorState {
    this.assertOpen()
    const input = record(payload)
    const workspace = normalizePath(string(input.workspace, 'workspace'))
    const connectionId = string(input.connectionId, 'connectionId', 256)
    const sequence = integer(input.sequence, 'sequence')
    this.expire()
    const entry = this.entries.get(workspace)
    if (!entry?.lease || entry.lease.id !== connectionId) throw new SocketError('disconnected', 'Reconnect the editor before sending updates')
    if (sequence <= entry.lease.sequence) return this.state(workspace)
    // Validate the complete command before changing its sequence or renewing its lease.
    if (method === 'update') {
      entry.live = snapshotOf(input.snapshot, entry.workspace, this.limits)
    } else if (method === 'clear' || method === 'disconnect') {
      entry.live = null
    } else if (method !== 'heartbeat') throw new SocketError('not-found', 'Unknown editor operation')
    entry.lease.sequence = sequence
    entry.lease.expires = this.now() + this.limits.leaseMs
    if (method === 'disconnect') delete entry.lease
    if (method !== 'heartbeat') this.changed(workspace, entry)
    return this.state(workspace)
  }

  /** Browser-side controls guard the revision the user actually saw. */
  edit(workspace: string | undefined, payload: unknown): EditorState {
    const input = record(payload)
    string(input.version, 'version', 256)
    this.expire()
    const entry = workspace !== undefined ? this.entries.get(normalizePath(workspace)) : undefined
    if (!entry || entry.version !== input.version) throw new SocketError('conflict', 'Editor context changed; try again')
    if (input.action !== 'clear') throw new SocketError('invalid', 'Unknown editor control')
    entry.live = null
    this.changed(entry.workspace, entry)
    return this.state(entry.workspace)
  }

  state(workspace: string | undefined): EditorState {
    this.expire()
    const entry = workspace !== undefined ? this.entries.get(normalizePath(workspace)) : undefined
    return structuredClone({
      workspace: entry?.workspace ?? '', version: entry?.version ?? `${this.epoch}:empty`,
      connected: !!entry?.lease, editor: entry?.lease?.editor ?? null,
      live: entry?.live ?? null,
    })
  }

  /** Freeze the live reference of one working directory; later editor changes cannot alter this capture. */
  capture(workspace: string, commit?: (snapshots: readonly EditorSnapshot[]) => void): readonly EditorSnapshot[] {
    this.expire()
    const entry = this.entries.get(normalizePath(workspace))
    if (!entry) return []
    const result = structuredClone(entry.live ? [entry.live] : [])
    if (result.length) commit?.(result)
    return result
  }

  /** Long polling has no idle polling traffic; updates wake every observing browser. */
  async watch(workspace: string | undefined, version: string, signal: AbortSignal): Promise<EditorState> {
    this.assertOpen()
    signal.throwIfAborted()
    const initial = this.state(workspace)
    if (initial.version !== version) return initial
    if (workspace === undefined) {
      // Sessions without a directory never change; keep the observer's polling cadence.
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => resolve(), this.limits.watchMs)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      this.assertOpen()
      return this.state(undefined)
    }
    if (this.watcherCount >= this.limits.maxWatchers) throw new SocketError('capacity', 'Too many editor subscriptions')
    await new Promise<void>((resolve, reject) => {
      const listeners = this.listeners.get(workspace) ?? new Set<() => void>()
      this.listeners.set(workspace, listeners)
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        listeners.delete(done)
        if (!listeners.size) this.listeners.delete(workspace)
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
    return this.state(workspace)
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

  dispose(): void {
    this.disposed = true
    this.entries.clear()
    for (const id of [...this.listeners.keys()]) this.notify(id)
  }

  private changed(workspace: string, entry: Entry): void {
    entry.version = this.version()
    if (!entry.lease && !entry.live) this.entries.delete(workspace)
    this.notify(workspace)
  }
  private notify(workspace: string): void { for (const listener of [...this.listeners.get(workspace) ?? []]) listener() }
  private version(): string { return `${this.epoch}:${++this.revision}` }
  private assertOpen(): void { if (this.disposed) throw new SocketError('closed', 'Editor socket has stopped') }
}
