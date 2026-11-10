/**
 * VS Code activation entry for the Claude Code selection bridge.
 *
 * The extension does one narrow thing: watch the Claude Code IDE socket for
 * selection changes and mirror them into dsh-editor-socket as an `EditorSnapshot`.
 * Transport and discovery live in `claude.ts` (no VS Code imports) so they stay
 * testable under plain Node; everything VS Code-specific is here.
 *
 * Failure policy: every attempt either bridges or schedules an exponential
 * backoff retry (1s → 30s). Nothing throws out of the extension host.
 */

import { createHash } from 'node:crypto'
import * as vscode from 'vscode'
import { EditorPlug, discoverSockets } from 'dsh-editor-plug'
import type { Registration } from 'dsh-editor-plug'
import { SocketError } from 'dsh-editor-protocol'
import type { EditorSnapshot } from 'dsh-editor-protocol'
import { connectClaudeSocket, discoverClaudeConnection } from './claude.ts'
import type { ClaudeConnection, ClaudeSelection } from './claude.ts'

const PREFIX = '[dsh-claude-adapter]'
const EDITOR_NAME = 'VS Code (Claude)'
const INITIAL_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
/** A socket that survived this long was healthy; only then reset the backoff. */
const MIN_HEALTHY_SOCKET_MS = 10_000
/** Back off lazily-rebuilt dsh leases after a mutation is rejected (e.g. a bad snapshot). */
const PLUG_RETRY_COOLDOWN_MS = 2_000
/** How often a live lease is checked for a latched heartbeat failure. */
const WATCHDOG_INTERVAL_MS = 5_000
/** Internal marker for a selection dropped by our own rate limit; not a real transport failure. */
const COOLDOWN_MESSAGE = 'dsh reconnection is cooling down'
/** Leave headroom under the socket's default 32768-byte selection text budget. */
const MAX_TEXT_BYTES = 30_000

function log(message: string): void {
  console.log(`${PREFIX} ${message}`)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Directory comparison that tolerates trailing slashes and Windows drive-letter case. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replaceAll('\\', '/').replace(/\/+$/u, '').replace(/^([A-Za-z]):/u, (_match, drive: string) => `${drive.toLowerCase()}:`)
  return normalize(left) === normalize(right)
}

/**
 * Claude Code → dsh snapshot. Positions are already 1-based line + 0-based
 * character on both sides, so no arithmetic is needed.
 *
 * An empty caret selection is a *file* reference, not a range: send no
 * `selection` at all so the composer chip degrades to a bare path.
 */
export function toSnapshot(selection: ClaudeSelection, workspace: string): EditorSnapshot {
  const base = { path: selection.filePath, workspace }
  if (selection.selection.isEmpty === true) return base
  const { start, end } = selection.selection
  // The protocol rejects a reversed pair on a single line; drop columns instead of failing the update.
  const columns = start.line === end.line && end.character < start.character
    ? {}
    : { startCharacter: start.character, endCharacter: end.character }
  const text = Buffer.byteLength(selection.text, 'utf8') <= MAX_TEXT_BYTES ? { text: selection.text } : {}
  return { ...base, selection: { start: start.line, end: end.line, ...columns, ...text } }
}

type PlugAttempt = { readonly plug: EditorPlug } | { readonly failure: 'no-socket' | 'busy' }

/** Per-window bridge; one instance lives for the whole extension host session. */
class ClaudeBridge {
  private stopped = true
  private generation = 0
  private socket: { close(): void } | undefined
  private plug: EditorPlug | undefined
  private pendingPlug: Promise<EditorPlug> | undefined
  /** Earliest time a new dsh lease may be attempted after a rejected mutation. */
  private plugRetryAfter = 0
  private retryTimer: NodeJS.Timeout | undefined
  private retryDelay = INITIAL_RETRY_MS
  private socketOpenedAt = 0
  /** Last snapshot rejected during a cooldown, replayed once the cooldown expires. */
  private pending: { snapshot: EditorSnapshot; workspace: string; owner: { close(): void } } | undefined
  private flushTimer: NodeJS.Timeout | undefined
  private watchdog: NodeJS.Timeout | undefined
  /** Last failure cause; suppresses repeat log lines across backoff attempts. */
  private outcome: string | undefined
  /** Whether this discovery cycle has already announced itself. */
  private announced = false
  /** Claude IDE endpoint last reported, so repeats stay quiet while it is unchanged. */
  private lastClaudeUrl: string | undefined
  private multiRootWarned = false
  private tail: Promise<unknown> = Promise.resolve()

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.generation++
    this.retryDelay = INITIAL_RETRY_MS
    log('bridge started')
    this.startWatchdog()
    this.enqueue(() => this.tick())
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.socket && !this.plug) return
    this.stopped = true
    // Invalidate any tick() that is mid-flight; it will drop whatever it just connected.
    this.generation++
    log('bridge stopped')
    this.stopWatchdog()
    this.pending = undefined
    for (const timer of [this.retryTimer, this.flushTimer]) if (timer) clearTimeout(timer)
    this.retryTimer = undefined
    this.flushTimer = undefined
    // Teardown goes through the queue so it cannot interleave with a connect still in flight.
    await this.enqueue(async () => {
      this.closeSocket()
      await this.releasePlug()
    })
  }

  /** Explicit reconnect from the command palette: drop everything and rediscover. */
  async restart(): Promise<void> {
    await this.stop()
    this.start()
  }

  /** Serialize every state transition so a timer and a command cannot race. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work, work).catch((error: unknown) => {
      log(`internal bridge error: ${describe(error)}`)
    })
    this.tail = run
    return run
  }

  private workspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) return undefined
    if (folders.length > 1 && !this.multiRootWarned) {
      this.multiRootWarned = true
      log(`multi-root workspace detected; only the first folder is bridged (${folders[0]?.uri.fsPath ?? '?'})`)
    }
    const folder = folders[0]
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined
  }

  private clientId(workspace: string): string {
    // Stable across reloads of the same window; hashed so the id leaks neither machine id nor path.
    const digest = createHash('sha256').update(`${vscode.env.machineId}\u0000${workspace}`).digest('hex')
    return `vscode-claude-${digest.slice(0, 32)}`
  }

  /**
   * Log once per distinct failure cause: a retry cycle that keeps hitting the same
   * missing prerequisite should not spam the extension host log every backoff step.
   */
  private note(outcome: string, message: string): void {
    if (this.outcome === outcome) return
    this.outcome = outcome
    log(message)
  }

  private scheduleRetry(outcome: string, message: string): void {
    if (this.stopped) return
    this.note(outcome, message)
    if (this.retryTimer) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(delay * 2, MAX_RETRY_MS)
    log(`retry scheduled in ${delay}ms`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.announced = false
      void this.enqueue(() => this.tick())
    }, delay)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const generation = this.generation
    const workspace = this.workspacePath()
    if (!workspace) {
      this.scheduleRetry('no-workspace', 'no workspace folder is open; will retry')
      return
    }
    if (!this.announced) {
      this.announced = true
      log(`discovery started for ${workspace}`)
    }

    const connection: ClaudeConnection | undefined = discoverClaudeConnection(workspace)
    if (!connection) {
      this.lastClaudeUrl = undefined
      this.scheduleRetry(`claude:${workspace}`, 'Claude Code IDE not detected; will retry')
      return
    }
    if (this.lastClaudeUrl !== connection.url) {
      this.lastClaudeUrl = connection.url
      log(`discovery hit: Claude Code IDE at ${connection.url}`)
    }

    const attempt = await this.connectPlug(workspace)
    if ('failure' in attempt) {
      if (attempt.failure === 'busy') this.scheduleRetry(`busy:${workspace}`, 'another editor window owns this workspace in dsh; will retry')
      else this.scheduleRetry(`dsh:${workspace}`, 'dsh-editor-socket for this workspace not found; will retry')
      return
    }
    // A stop/restart landed while we were connecting, or a socket is already live: never stack two leases.
    if (this.stopped || generation !== this.generation || this.socket || this.plug) {
      await attempt.plug.disconnect().catch(() => {})
      return
    }
    this.plug = attempt.plug
    this.outcome = undefined
    // A working pipeline means the next break should start from the short delay again.
    this.retryDelay = INITIAL_RETRY_MS
    log(`plug connected as ${EDITOR_NAME} for ${workspace}`)

    // Identify the socket handle before connecting so a synchronous onClose can still be matched.
    let socket: { close(): void } | undefined
    const handle: { close(): void } = {
      close: () => {
        try {
          socket?.close()
        } catch {
          // already gone
        }
      },
    }
    this.socket = handle
    this.socketOpenedAt = Date.now()
    try {
      socket = connectClaudeSocket(connection, {
        onSelection: (selection) => {
          void this.push(selection, workspace, handle)
        },
        onClose: () => {
          void this.onSocketClosed(handle)
        },
        onError: (error) => {
          // Node's WebSocket always emits close after error; let onClose drive the reconnect.
          log(`socket error: ${describe(error)}`)
        },
      })
    } catch (error) {
      this.socket = undefined
      log(`socket connect failed: ${describe(error)}`)
      await this.releasePlug()
      this.scheduleRetry(`claude-connect:${workspace}`, 'could not connect to the Claude Code IDE socket; will retry')
    }
  }

  /** dsh registrations whose advertised sessions include this workspace, probed over the socket API. */
  private async matchingRegistrations(workspace: string): Promise<{ matched: readonly Registration[]; all: readonly Registration[] }> {
    const all = await discoverSockets()
    // A probe plug never connects, so it holds no lease; sessions() is a read-only listing.
    // Probe in parallel: a stale registration can otherwise stall startup for its full timeout.
    const verdicts = await Promise.all(all.map(async (registration) => {
      const probe = new EditorPlug({
        url: registration.url,
        headers: { authorization: `Bearer ${registration.token}` },
        timeoutMs: 5_000,
      })
      try {
        const sessions = await probe.sessions()
        return sessions.some((session) => samePath(session.directory, workspace))
      } catch (error) {
        log(`socket ${registration.url} session listing failed: ${describe(error)}`)
        return false
      }
    }))
    return { matched: all.filter((_registration, index) => verdicts[index]), all }
  }

  /**
   * Prefer the socket that advertises a session in this directory. If none does (a directory
   * with no DSH session yet, or a listing failure) fall back to trying every registration:
   * the socket itself rejects directories the DSH host cannot see.
   */
  private async connectPlug(workspace: string): Promise<PlugAttempt> {
    let matched: readonly Registration[]
    let all: readonly Registration[]
    try {
      ({ matched, all } = await this.matchingRegistrations(workspace))
    } catch (error) {
      log(`socket discovery failed: ${describe(error)}`)
      return { failure: 'no-socket' }
    }
    if (all.length === 0) return { failure: 'no-socket' }
    // Multiple hosts running is the only case where registration choice matters enough to log.
    if (all.length > 1) log(`${matched.length}/${all.length} dsh socket(s) advertise this workspace; trying matched first`)
    const ordered = [...matched, ...all.filter((item) => !matched.includes(item))]

    let busy = false
    for (const registration of ordered) {
      if (this.stopped) break
      const plug = new EditorPlug({
        url: registration.url,
        headers: { authorization: `Bearer ${registration.token}` },
        timeoutMs: 10_000,
      })
      try {
        await plug.connect({ clientId: this.clientId(workspace), editor: EDITOR_NAME, workspace })
        return { plug }
      } catch (error) {
        const code = error instanceof SocketError ? error.code : undefined
        if (code === 'busy') busy = true
        log(`socket ${registration.url} not used (${code ?? describe(error)})`)
      }
    }
    return { failure: busy ? 'busy' : 'no-socket' }
  }

  private async push(selection: ClaudeSelection, workspace: string, owner: { close(): void }): Promise<void> {
    // Ignore late notifications from a socket that has already been replaced or torn down.
    if (this.stopped || this.socket !== owner) return
    const snapshot = toSnapshot(selection, workspace)
    await this.deliver(snapshot, workspace, owner)
  }

  private async deliver(snapshot: EditorSnapshot, workspace: string, owner: { close(): void }, replay = false): Promise<void> {
    let plug: EditorPlug | undefined
    try {
      plug = await this.ensurePlug(workspace)
      if (this.stopped || this.socket !== owner) return
      await plug.update(snapshot)
      // Ranges only: never log selected text.
      const range = snapshot.selection
      log(`selection pushed: ${snapshot.path}${range ? `#L${range.start}-${range.end}` : ''}`)
    } catch (error) {
      const coolingDown = error instanceof Error && error.message === COOLDOWN_MESSAGE
      // Drop only the lease this selection used; a concurrent reconnect may already own a new one.
      if (plug && this.plug === plug) await this.releasePlug()
      if (!coolingDown) {
        // Never log the snapshot itself: only the failure reason is safe to record.
        log(`selection update rejected: ${describe(error)}`)
        // The lease is likely gone (DSH restarted). Rebuild it lazily, but rate-limit so a
        // deterministically bad snapshot cannot turn every keystroke into a reconnect.
        this.plugRetryAfter = Date.now() + PLUG_RETRY_COOLDOWN_MS
      }
      // A replay that fails for a real reason means the snapshot itself is unacceptable; drop it.
      if (replay && !coolingDown) {
        log('dropping the retained selection; it was rejected again after reconnecting')
        return
      }
      // Retain the newest selection so a transient dsh outage does not silently lose it. One slot is
      // enough: a later selection supersedes an earlier one, exactly like the live reference.
      this.pending = { snapshot, workspace, owner }
      this.scheduleFlush()
    }
  }

  /** Replay the retained selection once the cooldown allows another lease attempt. */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    const delay = Math.max(0, this.plugRetryAfter - Date.now())
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const held = this.pending
      if (!held || this.stopped) return
      // A newer rejection may have pushed the cooldown out past this timer's deadline.
      if (Date.now() < this.plugRetryAfter) {
        this.scheduleFlush()
        return
      }
      this.pending = undefined
      if (this.socket !== held.owner) return
      void this.deliver(held.snapshot, held.workspace, held.owner, true)
    }, delay)
    this.flushTimer.unref?.()
  }

  /** Rented lease, rebuilt on demand after a mutation failure; keep the Claude socket untouched. */
  private ensurePlug(workspace: string): Promise<EditorPlug> {
    const current = this.plug
    if (current && !current.error) return Promise.resolve(current)
    if (Date.now() < this.plugRetryAfter) return Promise.reject(new Error(COOLDOWN_MESSAGE))
    // Coalesce a burst of selections behind one reconnect attempt.
    this.pendingPlug ??= (async () => {
      await this.releasePlug()
      const attempt = await this.connectPlug(workspace)
      if ('failure' in attempt) throw new Error(attempt.failure === 'busy'
        ? 'another editor window owns this workspace in dsh'
        : 'no dsh-editor-socket for this workspace')
      if (this.stopped) {
        await attempt.plug.disconnect().catch(() => {})
        throw new Error('bridge stopped while reconnecting')
      }
      this.plug = attempt.plug
      this.plugRetryAfter = 0
      log(`plug reconnected as ${EDITOR_NAME} for ${workspace}`)
      return attempt.plug
    })().finally(() => { this.pendingPlug = undefined })
    return this.pendingPlug
  }

  /**
   * The plug's heartbeat is the only signal that a dsh host went away while no selection changed.
   * Poll its error latch and rebuild the pipeline so the chip does not sit stale forever after
   * `dsh web` restarts on a new port.
   */
  private startWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      const plug = this.plug
      if (!plug?.error || this.stopped) return
      const reason = describe(plug.error)
      log(`heartbeat failed (${reason}); rediscovering`)
      void this.enqueue(async () => {
        if (this.plug !== plug) return
        this.closeSocket()
        await this.releasePlug()
      }).then(() => {
        this.scheduleRetry('heartbeat', 'dsh connection lost; will retry')
      })
    }, WATCHDOG_INTERVAL_MS)
    this.watchdog.unref?.()
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  private async onSocketClosed(from: { close(): void } | undefined): Promise<void> {
    if (this.socket !== from) return
    this.socket = undefined
    if (this.stopped) return
    // A socket that dies almost immediately is flapping; keep the escalated delay instead of resetting it.
    const lifetime = this.socketOpenedAt ? Date.now() - this.socketOpenedAt : MAX_RETRY_MS
    if (lifetime >= MIN_HEALTHY_SOCKET_MS) this.retryDelay = INITIAL_RETRY_MS
    log(`Claude Code IDE socket closed after ${lifetime}ms; rediscovering`)
    await this.enqueue(async () => {
      await this.releasePlug()
    })
    this.scheduleRetry('socket-closed', 'Claude Code IDE socket closed; will retry')
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close()
    } catch {
      // already gone
    }
  }

  private async releasePlug(): Promise<void> {
    const plug = this.plug
    this.plug = undefined
    if (!plug) return
    try {
      await plug.disconnect()
    } catch (error) {
      log(`plug disconnect failed: ${describe(error)}`)
    }
  }
}

let bridge: ClaudeBridge | undefined

export function activate(context: vscode.ExtensionContext): void {
  const instance = new ClaudeBridge()
  bridge = instance

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh-claude-adapter.connect', () => {
      log('connect requested from command palette')
      return instance.restart()
    }),
    vscode.commands.registerCommand('dsh-claude-adapter.disconnect', async () => {
      log('disconnect requested from command palette')
      await instance.stop()
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dsh-claude-adapter.autoConnect')) return
      const enabled = vscode.workspace.getConfiguration('dsh-claude-adapter').get<boolean>('autoConnect', true)
      if (enabled) {
        log('autoConnect enabled')
        void instance.restart()
      } else {
        log('autoConnect disabled')
        void instance.stop()
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!vscode.workspace.getConfiguration('dsh-claude-adapter').get<boolean>('autoConnect', true)) return
      log('workspace folders changed; restarting bridge')
      void instance.restart()
    }),
  )

  if (vscode.workspace.getConfiguration('dsh-claude-adapter').get<boolean>('autoConnect', true)) {
    instance.start()
  } else {
    log('autoConnect is disabled; run "DSH: Connect Claude Selections" to bridge manually')
  }
}

export async function deactivate(): Promise<void> {
  const instance = bridge
  bridge = undefined
  await instance?.stop()
}
