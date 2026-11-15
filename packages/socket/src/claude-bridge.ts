/**
 * Built-in Claude Code selection bridge.
 *
 * Reads the local Claude Code IDE lock files, pairs matching VS Code windows
 * with DSH working directories, and mirrors each `selection_changed` event into
 * the workspace lease that the composer already watches. The bridge acts as an
 * ordinary editor client: it leases the workspace, heartbeats, and disconnects
 * on teardown, so every existing state/capture path works unchanged.
 *
 * A real editor always outranks a bridge: an editor connection takes the lease
 * over, and the bridge yields while the editor owns it. This keeps the optional
 * Claude source from fighting `vsc-agents-connector` or another editor window.
 */
import { normalizePath } from 'dsh-editor-protocol'
import { connectClaudeSocket, planBridges, readClaudeLocks, selectionSnapshot } from './claude.ts'
import type { ClaudeConnection, ClaudeSelection, ClaudeSocketHandle, ClaudeSocketHandlers } from './claude.ts'
import { BRIDGE_CLIENT_PREFIX } from './store.ts'
import type { EditorStore } from './store.ts'

export const CLAUDE_BRIDGE_EDITOR = 'VS Code (Claude)'
export const CLAUDE_BRIDGE_CLIENT_ID = `${BRIDGE_CLIENT_PREFIX}claude`
const DEFAULT_POLL_MS = 3000
const MAX_RETRY_MS = 30_000

export interface ClaudeBridgeLogger {
  info(message: string): void
  warn(message: string): void
}

export interface ClaudeBridgeOptions {
  readonly store: EditorStore
  /**
   * Directories DSH knows about: live sessions plus persisted session directories.
   * Returning a promise is supported for callers that have to list sessions first.
   */
  readonly workspaces: () => readonly string[] | Promise<readonly string[]>
  readonly lockRoot?: string
  readonly pollMs?: number
  readonly logger?: ClaudeBridgeLogger
  /** Test seams. */
  readonly connectSocket?: (connection: ClaudeConnection, handlers: ClaudeSocketHandlers) => ClaudeSocketHandle
  readonly now?: () => number
}

interface LiveBridge {
  readonly connection: ClaudeConnection
  readonly connectionId: string
  socket?: ClaudeSocketHandle
  sequence: number
  heartbeat?: NodeJS.Timeout
}

interface RetryState {
  failures: number
  retryAt: number
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ClaudeSelectionBridge {
  private readonly bridges = new Map<string, LiveBridge>()
  /** Failed endpoints back off exponentially so a dead Claude server cannot churn leases. */
  private readonly retries = new Map<string, RetryState>()
  private timer: NodeJS.Timeout | undefined
  private reconciling = false
  private stopped = true
  private lastOutcome: string | undefined

  constructor(private readonly options: ClaudeBridgeOptions) {}

  /** Start polling; the first reconcile pass runs immediately. */
  start(): void {
    if (!this.stopped) return
    // A runtime without the Node WebSocket global (older Electron/Node) simply skips the bridge.
    if (!this.options.connectSocket && typeof WebSocket === 'undefined') {
      this.options.logger?.warn('Claude bridge disabled: this runtime has no WebSocket implementation')
      return
    }
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.options.pollMs ?? DEFAULT_POLL_MS)
    this.timer.unref?.()
  }

  /** Stop polling and release every lease this bridge holds. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const workspace of [...this.bridges.keys()]) this.close(workspace)
  }

  /** One reconcile pass over DSH workspaces and Claude IDE lock files. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.reconciling || this.stopped) return
    this.reconciling = true
    try {
      const provided = this.options.workspaces()
      const directories = Array.isArray(provided) ? provided : await provided
      if (this.stopped) return
      const workspaces = [...new Set(directories.map(workspace => normalizePath(workspace)))]
      const plan = planBridges(readClaudeLocks(this.options.lockRoot), workspaces)
      for (const [workspace, bridge] of [...this.bridges]) {
        const target = plan.get(workspace)
        if (!target || target.url !== bridge.connection.url) {
          this.close(workspace)
          continue
        }
        // A real editor took the lease over (it outranks bridges); drop the stale socket.
        if (this.options.store.clientIdOf(workspace) !== CLAUDE_BRIDGE_CLIENT_ID) this.close(workspace)
      }
      if (this.stopped) return
      for (const [workspace, connection] of plan) {
        if (this.bridges.has(workspace) || !this.available(connection.url)) continue
        const owner = this.options.store.clientIdOf(workspace)
        if (owner !== undefined && owner !== CLAUDE_BRIDGE_CLIENT_ID) continue
        this.open(workspace, connection)
      }
    } catch (error) {
      this.note('discovery', `Claude bridge discovery failed: ${describe(error)}`, 'warn')
    } finally {
      this.reconciling = false
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private available(url: string): boolean {
    const state = this.retries.get(url)
    return state === undefined || state.retryAt <= this.now()
  }

  private markFailure(url: string, message: string): void {
    const state = this.retries.get(url) ?? { failures: 0, retryAt: 0 }
    state.failures += 1
    state.retryAt = this.now() + Math.min(1_000 * 2 ** (state.failures - 1), MAX_RETRY_MS)
    this.retries.set(url, state)
    this.note(`failed:${url}`, `${message}; retrying ${state.failures === 1 ? 'shortly' : 'with backoff'}`, 'warn')
  }

  private open(workspace: string, connection: ClaudeConnection): void {
    let connectionId: string
    try {
      connectionId = this.options.store.connect({
        clientId: CLAUDE_BRIDGE_CLIENT_ID, editor: CLAUDE_BRIDGE_EDITOR, workspace,
      }).connectionId
    } catch (error) {
      this.note(`lease:${workspace}`, `Claude bridge could not follow ${workspace}: ${describe(error)}`, 'warn')
      return
    }
    const bridge: LiveBridge = { connection, connectionId, sequence: 0 }
    this.bridges.set(workspace, bridge)
    try {
      bridge.socket = this.connect(connection, workspace, bridge)
    } catch (error) {
      this.markFailure(connection.url, `Claude bridge could not connect to ${connection.url}: ${describe(error)}`)
      this.close(workspace)
      return
    }
    const heartbeatMs = Math.max(1_000, Math.floor(this.options.store.limits.leaseMs / 3))
    bridge.heartbeat = setInterval(() => { this.heartbeat(workspace, bridge) }, heartbeatMs)
    bridge.heartbeat.unref?.()
    this.note(`connected:${workspace}`, `Claude bridge following ${workspace} at ${connection.url}`, 'info')
  }

  private connect(connection: ClaudeConnection, workspace: string, bridge: LiveBridge): ClaudeSocketHandle {
    const factory = this.options.connectSocket
      ?? ((target: ClaudeConnection, handlers: ClaudeSocketHandlers) => connectClaudeSocket(target, handlers))
    return factory(connection, {
      onOpen: () => { this.retries.delete(connection.url) },
      onSelection: selection => { this.push(workspace, bridge, selection) },
      onError: () => {
        // Node's WebSocket always emits close after error; let onClose drive the reconnect.
      },
      onClose: () => {
        // An expected close already removed the bridge from the map (teardown path).
        if (this.bridges.get(workspace) !== bridge) return
        this.markFailure(connection.url, `Claude Code IDE socket for ${workspace} closed`)
        this.close(workspace)
      },
    })
  }

  private push(workspace: string, bridge: LiveBridge, selection: ClaudeSelection): void {
    if (this.bridges.get(workspace) !== bridge) return
    let snapshot
    try {
      snapshot = selectionSnapshot(selection, workspace, this.options.store.limits.maxSelectionBytes)
    } catch (error) {
      // A file outside the workspace is the editor's problem, not a broken lease.
      this.note(`snapshot:${workspace}`, `Claude selection ignored: ${describe(error)}`, 'warn')
      return
    }
    bridge.sequence += 1
    try {
      this.options.store.mutate('update', {
        workspace, connectionId: bridge.connectionId, sequence: bridge.sequence, snapshot,
      })
    } catch (error) {
      this.note(`update:${workspace}`, `Claude selection rejected: ${describe(error)}`, 'warn')
      this.close(workspace)
    }
  }

  private heartbeat(workspace: string, bridge: LiveBridge): void {
    if (this.bridges.get(workspace) !== bridge) return
    bridge.sequence += 1
    try {
      this.options.store.mutate('heartbeat', {
        workspace, connectionId: bridge.connectionId, sequence: bridge.sequence,
      })
    } catch (error) {
      this.note(`heartbeat:${workspace}`, `Claude bridge heartbeat failed (${describe(error)}); reconnecting`, 'warn')
      this.close(workspace)
    }
  }

  private close(workspace: string): void {
    const bridge = this.bridges.get(workspace)
    if (!bridge) return
    this.bridges.delete(workspace)
    if (bridge.heartbeat) clearInterval(bridge.heartbeat)
    try {
      bridge.socket?.close()
    } catch {
      // already gone
    }
    // Release only our own lease: a takeover already replaced the connection id.
    if (this.options.store.clientIdOf(workspace) === CLAUDE_BRIDGE_CLIENT_ID) {
      try {
        this.options.store.mutate('disconnect', {
          workspace, connectionId: bridge.connectionId, sequence: bridge.sequence + 1,
        })
      } catch {
        // The lease may already be gone; nothing else to release.
      }
    }
  }

  /** Log one message per distinct failure cause so a flapping endpoint cannot spam the log. */
  private note(outcome: string, message: string, level: 'info' | 'warn'): void {
    if (this.lastOutcome === outcome) return
    this.lastOutcome = outcome
    if (level === 'info') this.options.logger?.info(message)
    else this.options.logger?.warn(message)
  }
}
