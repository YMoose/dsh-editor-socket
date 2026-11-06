/** Small editor-side client; no VS Code or DSH runtime imports. */
import { CHANNEL, PROTOCOL_VERSION, SocketError, record } from './protocol.ts'
import type { ConnectRequest, ConnectionReceipt, EditorSnapshot, EditorState, SessionDescriptor } from './protocol.ts'

export interface PlugOptions {
  /** The dedicated loopback endpoint from a validated socket registration. */
  readonly url: string
  /** Socket bearer authorization supplied by the caller. Never logged. */
  readonly headers?: HeadersInit
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export class EditorPlug {
  private readonly url: string
  private readonly fetchFn: typeof fetch
  private readonly headers: Headers
  private sequence = 0
  private receipt?: ConnectionReceipt
  private timer?: ReturnType<typeof setInterval>
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private connecting = false
  private closing?: Promise<void>
  /** Last heartbeat failure; the caller can surface it and offer reconnect. */
  error: Error | undefined

  constructor(private readonly options: PlugOptions) {
    const url = new URL(options.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Use a clean HTTP(S) server URL and explicit authentication headers')
    }
    this.url = url.href.replace(/\/+$/u, '')
    this.fetchFn = options.fetch ?? fetch
    this.headers = new Headers(options.headers)
    this.headers.set('content-type', 'application/json')
  }

  async sessions(): Promise<readonly SessionDescriptor[]> { return await this.call('sessions', {}) as SessionDescriptor[] }

  async connect(request: ConnectRequest): Promise<ConnectionReceipt> {
    if (this.receipt || this.connecting || this.closing) throw new Error('Disconnect this plug before reconnecting')
    this.connecting = true
    try {
      const info = record(await this.call('info', {}))
      if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported editor socket protocol')
      const receipt = await this.call('connect', request) as ConnectionReceipt
      this.receipt = receipt
      this.sequence = 0
      this.stopped = false
      this.error = undefined
      this.timer = setInterval(() => {
        void this.mutate('heartbeat').catch(error => {
          this.error = error instanceof Error ? error : new Error(String(error))
          if (this.timer) clearInterval(this.timer)
        })
      }, receipt.heartbeatMs)
      this.timer.unref?.()
      return receipt
    } finally { this.connecting = false }
  }

  update(snapshot: EditorSnapshot): Promise<EditorState> { return this.mutate('update', { snapshot }) }
  pin(snapshot?: EditorSnapshot): Promise<EditorState> { return this.mutate('pin', snapshot ? { snapshot } : {}) }
  clear(): Promise<EditorState> { return this.mutate('clear') }

  disconnect(): Promise<void> {
    if (this.connecting) return Promise.reject(new Error('Wait for connect before disconnecting'))
    if (this.closing) return this.closing
    if (this.timer) clearInterval(this.timer)
    if (!this.receipt) return Promise.resolve()
    const closing = this.mutate('disconnect')
    this.closing = closing.then(() => {}).finally(() => {
      this.stopped = true; this.receipt = undefined; this.closing = undefined
    })
    return this.closing
  }

  private mutate(method: string, extra: object = {}): Promise<EditorState> {
    const receipt = this.receipt
    if (!receipt || this.closing || (this.stopped && method !== 'disconnect')) return Promise.reject(new Error('Editor plug is not connected'))
    // Serialization prevents a slow update overtaking an explicit pin or disconnect.
    const sequence = ++this.sequence
    const payload = structuredClone({ sessionId: receipt.state.sessionId, connectionId: receipt.connectionId, sequence, ...extra })
    const run = this.tail.then(async () => {
      if (this.error && method !== 'disconnect') throw this.error
      try { return await this.call(method, payload) as EditorState }
      catch (error) {
        this.error = error instanceof Error ? error : new Error(String(error))
        this.stopped = true
        if (this.timer) clearInterval(this.timer)
        throw this.error
      }
    })
    this.tail = run.catch(() => {})
    return run
  }

  private async call(method: string, payload: object): Promise<unknown> {
    const rpcId = crypto.randomUUID()
    const response = await this.fetchFn(`${this.url}${CHANNEL}/${method}`, {
      method: 'POST', headers: this.headers,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`DSH editor socket returned HTTP ${response.status}`)
    const envelope = record(await response.json())
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('Invalid editor socket response')
    const result = record(envelope.result)
    if (result.ok !== true) {
      const failure = record(result.error)
      throw new SocketError(String(failure.code), String(failure.message))
    }
    return result.value
  }
}
