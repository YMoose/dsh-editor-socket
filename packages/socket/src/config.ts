import { SocketError } from 'dsh-editor-protocol'
import type { ProtocolLimits } from 'dsh-editor-protocol'

export type Config = Partial<ProtocolLimits> & {
  /** Private per-instance registration files for local editor discovery. */
  readonly discoveryDirectory?: string
}

/** Defaults bound transient state; every deployment limit can be set in cordis.yml. */
export function resolveConfig(config: Config = {}): ProtocolLimits {
  const result: ProtocolLimits = {
    maxSelectionBytes: 32_768, maxWorkspaces: 32,
    leaseMs: 30_000, watchMs: 25_000, maxWatchers: 128,
    ...Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'discoveryDirectory')),
  }
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new SocketError('config', `Invalid ${key}`)
  }
  if (result.leaseMs < 3000 || result.leaseMs > 300_000 || result.watchMs > 30_000) {
    throw new SocketError('config', 'leaseMs must be 3000–300000; watchMs must be at most 30000')
  }
  return result
}
