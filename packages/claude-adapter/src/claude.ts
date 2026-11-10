/**
 * Claude Code IDE integration: discovery, websocket client, and selection
 * decoding. This module has no VS Code dependency so it stays unit-testable
 * under plain Node. The extension host layer lives in `extension.ts`.
 *
 * Protocol summary (verified against Claude Code 2.1.319):
 *   - Lock files at ~/.claude/ide/<port>.lock describe live WS servers.
 *   - Each lock carries { pid, workspaceFolders, transport: "ws", authToken }.
 *   - WS handshake: GET ws://127.0.0.1:<port> with header
 *     `x-claude-code-ide-authorization: <authToken>`.
 *   - On connect, client sends JSON-RPC `initialize`; server replies with
 *     serverInfo; client sends `notifications/initialized`; server then
 *     pushes `selection_changed` notifications whenever the user's selection
 *     changes (including immediately after init, with the current selection).
 *   - Selection positions are 1-based lines + 0-based characters.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
  readonly fileUrl?: string
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

/** Directory that holds Claude Code IDE lock files. */
export function claudeLockRoot(homeDir: string = homedir()): string {
  return path.join(homeDir, '.claude', 'ide')
}

/**
 * Score how well a lock file's workspaceFolders match `directory`.
 * Higher is better; <= 0 means no containment. Mirrors the algorithm in
 * opencode's `discoverEditorConnection` so the two clients pick the same
 * window when both are running.
 */
function containmentScore(folder: string, directory: string): number {
  const resolvedFolder = path.resolve(folder)
  const resolvedDirectory = path.resolve(directory)
  const relative = path.relative(resolvedFolder, resolvedDirectory)
  if (relative === '') return resolvedFolder.length
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 0
  return resolvedFolder.length
}

/** Parse a single `.lock` file; returns undefined on any malformed content. */
export function parseLockFile(file: string): ClaudeLockInfo | undefined {
  const base = path.basename(file, '.lock')
  const port = Number.parseInt(base, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (value.transport !== undefined && value.transport !== 'ws') return undefined
    if (typeof value.authToken !== 'string' || !value.authToken) return undefined
    if (typeof value.pid !== 'number') return undefined
    const folders = Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter((item): item is string => typeof item === 'string')
      : []
    return {
      port,
      pid: value.pid,
      workspaceFolders: folders,
      authToken: value.authToken,
      mtimeMs: statSync(file).mtimeMs,
    }
  } catch {
    return undefined
  }
}

/**
 * Pick the best Claude Code IDE server for `directory`.
 * Returns undefined when no lock file claims the directory.
 */
export function discoverClaudeConnection(
  directory: string,
  lockRoot: string = claudeLockRoot(),
): ClaudeConnection | undefined {
  if (!existsSync(lockRoot)) return undefined
  const candidates = readdirSync(lockRoot)
    .filter((entry) => entry.endsWith('.lock'))
    .map((entry) => parseLockFile(path.join(lockRoot, entry)))
    .filter((lock): lock is ClaudeLockInfo => lock !== undefined)
    .map((lock) => {
      const score = Math.max(0, ...lock.workspaceFolders.map((f) => containmentScore(f, directory)))
      return { lock, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.lock.mtimeMs - a.lock.mtimeMs)
  const best = candidates[0]?.lock
  if (!best) return undefined
  return {
    url: `ws://127.0.0.1:${best.port}`,
    authToken: best.authToken,
    workspaceFolders: best.workspaceFolders,
  }
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

/**
 * Decode an incoming `selection_changed` notification.
 * Returns undefined for anything that isn't a well-formed selection payload.
 */
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
    fileUrl: typeof p.fileUrl === 'string' ? p.fileUrl : undefined,
    selection: {
      start: { line: startPos.line, character: startPos.character },
      end: { line: endPos.line, character: endPos.character },
      isEmpty: typeof s.isEmpty === 'boolean' ? s.isEmpty : undefined,
    },
  }
}

export type ClaudeSocketHandlers = {
  /** Server's initialize response arrived. */
  readonly onServerInfo?: (info: { name?: string; version?: string }) => void
  /** A selection_changed notification arrived and decoded cleanly. */
  readonly onSelection: (selection: ClaudeSelection) => void
  /** The socket closed (will trigger reconnect upstream). */
  readonly onClose?: () => void
  /** Transport-level error. */
  readonly onError?: (error: Error) => void
}

/**
 * Open a websocket to a Claude Code IDE server and drive the MCP-ish
 * handshake. Returns a handle whose `close()` detaches cleanly.
 *
 * `WebSocketImpl` is injectable so tests can substitute a fake; in
 * production pass the global `WebSocket` (Node 22+ has one built in).
 */
export function connectClaudeSocket(
  connection: ClaudeConnection,
  handlers: ClaudeSocketHandlers,
  WebSocketImpl: typeof WebSocket = WebSocket,
): { close: () => void } {
  const socket = new WebSocketImpl(connection.url, {
    headers: { 'x-claude-code-ide-authorization': connection.authToken },
  } as never)
  let closed = false

  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-claude-adapter', version: '0.1.0' },
        },
      }),
    )
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
      } catch {
        // send races with close; harmless
      }
    }
  })

  socket.addEventListener('close', () => {
    if (closed) return
    closed = true
    handlers.onClose?.()
  })
  socket.addEventListener('error', () => {
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
