/** Loopback editor carrier plus DSH's native HTTP/IPC response envelope. */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { CHANNEL, PROTOCOL_VERSION, SocketError, record, string } from './protocol.ts'
import { defaultDiscoveryDirectory } from './discovery.ts'
import type { Registration } from './discovery.ts'
export type { Registration } from './discovery.ts'

export type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }
export type Dispatch = (method: string, payload: unknown, signal: AbortSignal) => Promise<Result>
export const METHODS = ['info', 'sessions', 'connect', 'state', 'watch', 'edit', 'update', 'clear', 'heartbeat', 'disconnect'] as const

/** Decode exactly the Connection RPC envelope used by DSH browser and IPC clients. */
export async function respond(dispatch: Dispatch, method: string, input: unknown, signal: AbortSignal): Promise<object> {
  const envelope = record(input)
  const rpcId = string(envelope.rpcId, 'rpcId', 256)
  if (envelope.type !== 'client-request' || (envelope.method !== method && envelope.method !== `editor-socket/${method}`)) {
    throw new SocketError('invalid', 'Invalid editor socket request envelope')
  }
  return { type: 'server-response', rpcId, result: await dispatch(method, envelope.payload, signal) }
}

/** Each activation owns one listener, one restricted token, and one registration file. */
export async function startSocket(dispatch: Dispatch, directory = defaultDiscoveryDirectory(), maxBytes = 262_144) {
  if (!isAbsolute(directory)) throw new Error('discoveryDirectory must be absolute')
  const token = randomBytes(32).toString('hex')
  const credential = Buffer.from(`Bearer ${token}`)
  const controllers = new Set<AbortController>()
  let authority = ''
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (req.headers.origin || req.headers.host !== authority) { res.writeHead(403).end(); return }
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) { res.writeHead(401).end(); return }
    const method = req.url?.startsWith(`${CHANNEL}/`) ? req.url.slice(CHANNEL.length + 1) : ''
    if (!METHODS.includes(method as typeof METHODS[number])) { res.writeHead(404).end(); return }
    if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415).end(); return }
    const abort = new AbortController()
    controllers.add(abort)
    res.on('close', () => { abort.abort(); controllers.delete(abort) })
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > maxBytes) { res.writeHead(413, { connection: 'close' }).end(); return }
        chunks.push(buffer)
      }
      const result = await respond(dispatch, method, JSON.parse(Buffer.concat(chunks).toString('utf8')), abort.signal)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result))
    } catch (error) {
      if (!abort.signal.aborted && !res.headersSent) res.writeHead(error instanceof SyntaxError || error instanceof SocketError ? 400 : 500).end()
    } finally { controllers.delete(abort) }
  }
  const server = createServer((req, res) => { void serve(req, res) })
  server.requestTimeout = 10_000
  server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Editor socket failed to bind TCP')
  authority = `127.0.0.1:${address.port}`
  const registration: Registration = { protocolVersion: PROTOCOL_VERSION, instanceId: randomUUID(), pid: process.pid, url: `http://${authority}`, token }
  const filename = join(directory, `${registration.instanceId}.json`)
  const closeServer = async () => {
    for (const controller of controllers) controller.abort()
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closing
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(filename, JSON.stringify(registration) + '\n', { mode: 0o600, flag: 'wx' })
  } catch (error) { await closeServer(); throw error }
  let closing: Promise<void> | undefined
  return {
    registration, filename,
    close: () => closing ??= (async () => {
      await closeServer()
      try { await unlink(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })(),
  }
}
