/** Local discovery shared with editor adapters; no DSH runtime dependencies. */
import { open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROTOCOL_VERSION, record } from './protocol.ts'

export interface Registration {
  readonly protocolVersion: number
  readonly instanceId: string
  readonly pid: number
  readonly url: string
  readonly token: string
}

export function defaultDiscoveryDirectory(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dsh-editor-socket')
}

/** Return validated owner-only registrations. Stale entries are probed by the caller, never deleted here. */
export async function discoverSockets(directory = defaultDiscoveryDirectory()): Promise<readonly Registration[]> {
  let files: string[]
  try { files = await readdir(directory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const registrations: Registration[] = []
  for (const filename of files.sort()) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(filename)) continue
    try {
      const file = await open(join(directory, filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 4096) continue
        if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) continue
        const value = record(JSON.parse(await file.readFile('utf8')))
        if (value.protocolVersion !== PROTOCOL_VERSION || `${String(value.instanceId)}.json` !== filename
          || typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(value.url)
          || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token)
          || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) continue
        const url = new URL(value.url)
        if (!url.port || Number(url.port) < 1) continue
        registrations.push({ protocolVersion: PROTOCOL_VERSION, instanceId: String(value.instanceId),
          pid: value.pid as number, url: value.url, token: value.token })
      } finally { await file.close() }
    } catch (error) {
      // An activation can exit midway through discovery; malformed or foreign files are not endpoints.
      if (error instanceof SyntaxError || error instanceof TypeError || (error as NodeJS.ErrnoException).code) continue
      throw error
    }
  }
  return registrations
}
