import { SocketError } from 'dsh-editor-protocol'
import type { ProtocolLimits } from 'dsh-editor-protocol'

export type Config = Partial<ProtocolLimits> & {
  /** Private per-instance registration files for local editor discovery. */
  readonly discoveryDirectory?: string
  /**
   * Follow the local Claude Code IDE selection without a VS Code bridge extension.
   * Defaults to true; disable it when another Claude WS client must own the IDE
   * socket (for example OpenCode TUI) or when using `vsc-agents-connector`.
   */
  readonly claudeBridge?: boolean
  /** Override the Claude Code IDE lock directory; defaults to `~/.claude/ide`. */
  readonly claudeLockRoot?: string
}

const NON_LIMIT_KEYS: ReadonlySet<string> = new Set(['discoveryDirectory', 'claudeBridge', 'claudeLockRoot'])

/** Defaults bound transient state; every deployment limit can be set in cordis.yml. */
export function resolveConfig(config: Config = {}): ProtocolLimits {
  const result: ProtocolLimits = {
    maxSelectionBytes: 32_768, maxWorkspaces: 32,
    leaseMs: 30_000, watchMs: 25_000, maxWatchers: 128,
    ...Object.fromEntries(Object.entries(config).filter(([key]) => !NON_LIMIT_KEYS.has(key))),
  }
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new SocketError('config', `Invalid ${key}`)
  }
  if (result.leaseMs < 3000 || result.leaseMs > 300_000 || result.watchMs > 30_000) {
    throw new SocketError('config', 'leaseMs must be 3000–300000; watchMs must be at most 30000')
  }
  return result
}
