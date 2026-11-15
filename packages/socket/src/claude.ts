/**
 * Claude Code IDE integration for the DSH host.
 *
 * A VS Code window with the Claude Code extension hosts a loopback WebSocket
 * server described by `~/.claude/ide/<port>.lock`. The host half can subscribe
 * to that server and mirror the current selection into a workspace lease, so
 * DSH follows the editor without installing a separate VS Code bridge
 * extension. This module has no DSH runtime dependency beyond the wire types,
 * so the discovery, decoding and coordinate conversion stay unit-testable.
 *
 * Protocol summary (verified against Claude Code 2.1.325):
 *   - Lock files carry { pid, workspaceFolders, transport: "ws", authToken }.
 *   - WS handshake: GET ws://127.0.0.1:<port> with header
 *     `x-claude-code-ide-authorization: <authToken>`.
 *   - After JSON-RPC `initialize` and `notifications/initialized`, the server
 *     pushes `selection_changed` notifications, including the current selection.
 *   - Positions are 0-based lines + 0-based characters (VS Code coordinates).
 *     The editor-socket wire format uses 1-based inclusive lines, so lines shift
 *     by one while characters pass through unchanged.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { normalizePath } from 'dsh-editor-protocol'
import type { EditorSnapshot } from 'dsh-editor-protocol'

export interface ClaudeLockInfo {
  readonly port: number
  readonly pid: number
  readonly workspaceFolders: readonly string[]
  readonly authToken: string
  readonly mtimeMs: number
}

export interface ClaudePosition {
  readonly line: number
  readonly character: number
}

export interface ClaudeSelection {
  readonly text: string
  readonly filePath: string
  readonly selection: {
    readonly start: ClaudePosition
    readonly end: ClaudePosition
    readonly isEmpty?: boolean
  }
}

export interface ClaudeConnection {
  readonly url: string
  readonly authToken: string
  readonly workspaceFolders: readonly string[]
}

export interface ClaudeSocketHandlers {
  readonly onSelection: (selection: ClaudeSelection) => void
  readonly onOpen?: () => void
  readonly onClose?: () => void
  readonly onError?: (error: Error) => void
  readonly onServerInfo?: (info: { name?: string; version?: string }) => void
}

export interface ClaudeSocketHandle {
  close(): void
}

/** Directory that holds Claude Code IDE lock files. */
export function claudeLockRoot(homeDir: string = homedir()): string {
  return join(homeDir, '.claude', 'ide')
}

/** Parse a single `.lock` file; returns undefined on any malformed content. */
export function parseLockFile(file: string): ClaudeLockInfo | undefined {
  const port = Number.parseInt(basename(file, '.lock'), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (value.transport !== undefined && value.transport !== 'ws') return undefined
    if (typeof value.authToken !== 'string' || !value.authToken) return undefined
    if (typeof value.pid !== 'number') return undefined
    const folders = Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter((item): item is string => typeof item === 'string')
      : []
    return { port, pid: value.pid, workspaceFolders: folders, authToken: value.authToken, mtimeMs: statSync(file).mtimeMs }
  } catch {
    return undefined
  }
}

/** Whether a lock's owning process is still running; crashed editors leave stale locks behind. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Read every usable lock file in the Claude IDE directory; a missing directory is
 * not an error. Locks whose owning process is gone are skipped so a crashed VS
 * Code window cannot trigger a reconnect loop against a dead port.
 */
export function readClaudeLocks(
  lockRoot: string = claudeLockRoot(),
  alive: (pid: number) => boolean = isProcessAlive,
): ClaudeLockInfo[] {
  if (!existsSync(lockRoot)) return []
  try {
    return readdirSync(lockRoot)
      .filter(entry => entry.endsWith('.lock'))
      .flatMap(entry => {
        const lock = parseLockFile(join(lockRoot, entry))
        return lock && alive(lock.pid) ? [lock] : []
      })
  } catch {
    return []
  }
}

/** Whether `child` names the same path as, or a path nested inside, `parent`. */
function isInside(child: string, parent: string): boolean {
  const nested = relative(resolve(parent), resolve(child))
  return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))
}

/**
 * Pair every workspace DSH knows about with the best Claude IDE server for it.
 *
 * A lock matches when one of its VS Code workspace folders is the workspace or
 * lives inside it, so an editor opened on a subdirectory still serves the
 * session's directory. An exact folder match outranks containment; ties prefer
 * the most recently touched window. Lock files for directories DSH has no live
 * session in are ignored.
 */
export function planBridges(
  locks: readonly ClaudeLockInfo[],
  workspaces: readonly string[],
): Map<string, ClaudeConnection> {
  const best = new Map<string, { lock: ClaudeLockInfo; score: number }>()
  for (const lock of locks) {
    for (const workspace of workspaces) {
      const normalized = normalizePath(workspace)
      let score = 0
      for (const folder of lock.workspaceFolders) {
        if (!isInside(folder, normalized)) continue
        score = Math.max(score, normalizePath(folder) === normalized ? 1_000_000 + folder.length : folder.length)
      }
      if (score === 0) continue
      const current = best.get(normalized)
      if (!current || score > current.score || (score === current.score && lock.mtimeMs > current.lock.mtimeMs)) {
        best.set(normalized, { lock, score })
      }
    }
  }
  return new Map([...best].map(([workspace, { lock }]) => [workspace, {
    url: `ws://127.0.0.1:${lock.port}`,
    authToken: lock.authToken,
    workspaceFolders: lock.workspaceFolders,
  }]))
}

/**
 * Claude selection → editor-socket snapshot.
 *
 * An empty caret is a *file* reference, not a range: omit `selection` entirely
 * so the composer chip degrades to a bare path. Oversized text is dropped while
 * the line/character range survives.
 */
export function selectionSnapshot(
  selection: ClaudeSelection,
  workspace: string,
  maxSelectionBytes: number,
): EditorSnapshot {
  const base = { path: normalizePath(selection.filePath), workspace: normalizePath(workspace) }
  if (selection.selection.isEmpty === true) return base
  const { start, end } = selection.selection
  const lineStart = start.line + 1
  const lineEnd = end.line + 1
  // The protocol rejects a reversed pair on a single line; drop columns instead of failing the update.
  const columns = lineStart === lineEnd && end.character < start.character
    ? {}
    : { startCharacter: start.character, endCharacter: end.character }
  const text = Buffer.byteLength(selection.text, 'utf8') <= maxSelectionBytes ? { text: selection.text } : {}
  return { ...base, selection: { start: lineStart, end: lineEnd, ...columns, ...text } }
}

/** Minimal JSON-RPC message shape used by the Claude IDE socket. */
interface JsonRpcMessage {
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

const MCP_PROTOCOL_VERSION = '2025-11-25'

/** Decode an incoming `selection_changed` notification; undefined for anything else. */
export function decodeSelectionChanged(params: unknown): ClaudeSelection | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const p = params as Record<string, unknown>
  if (typeof p.text !== 'string') return undefined
  if (typeof p.filePath !== 'string') return undefined
  const sel = p.selection
  if (typeof sel !== 'object' || sel === null) return undefined
  const s = sel as Record<string, unknown>
  const start = s.start
  const end = s.end
  if (typeof start !== 'object' || start === null) return undefined
  if (typeof end !== 'object' || end === null) return undefined
  const startPos = start as Record<string, unknown>
  const endPos = end as Record<string, unknown>
  if (typeof startPos.line !== 'number' || typeof startPos.character !== 'number') return undefined
  if (typeof endPos.line !== 'number' || typeof endPos.character !== 'number') return undefined
  return {
    text: p.text,
    filePath: p.filePath,
    selection: {
      start: { line: startPos.line, character: startPos.character },
      end: { line: endPos.line, character: endPos.character },
      isEmpty: typeof s.isEmpty === 'boolean' ? s.isEmpty : undefined,
    },
  }
}

/**
 * Open a WebSocket to a Claude Code IDE server and drive the MCP-ish handshake.
 * `WebSocketImpl` is injectable for tests; production passes the Node global.
 * `log` receives transport events only — never selection contents.
 */
export function connectClaudeSocket(
  connection: ClaudeConnection,
  handlers: ClaudeSocketHandlers,
  WebSocketImpl: typeof WebSocket = WebSocket,
  log?: (message: string) => void,
): ClaudeSocketHandle {
  const socket = new WebSocketImpl(connection.url, {
    headers: { 'x-claude-code-ide-authorization': connection.authToken },
  } as never)
  let closed = false

  socket.addEventListener('open', () => {
    handlers.onOpen?.()
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-editor-socket', version: '0.4.0' },
      },
    }))
  })

  socket.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : undefined
    if (!data) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(data) as JsonRpcMessage
    } catch {
      return
    }
    if (message.method === 'selection_changed') {
      const selection = decodeSelectionChanged(message.params)
      if (selection) handlers.onSelection(selection)
      return
    }
    if (message.id === 1 && message.result !== undefined) {
      const result = message.result as Record<string, unknown>
      const serverInfo = (result.serverInfo ?? {}) as Record<string, unknown>
      handlers.onServerInfo?.({
        name: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
        version: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
      })
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
        log?.('notifications/initialized sent')
      } catch {
        // send races with close; harmless
      }
    }
  })

  socket.addEventListener('close', (event) => {
    if (closed) return
    closed = true
    log?.(`socket closed code=${(event as CloseEvent).code}`)
    handlers.onClose?.()
  })
  socket.addEventListener('error', () => {
    log?.('socket error event')
    handlers.onError?.(new Error(`Claude IDE socket error on ${connection.url}`))
  })

  return {
    close: () => {
      if (closed) return
      closed = true
      try {
        socket.close()
      } catch {
        // already gone
      }
    },
  }
}
