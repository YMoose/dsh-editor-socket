/** Narrow, dependency-free CDP client for the isolated VS Code renderer. */
import { writeFile } from 'node:fs/promises'

export async function connect(run) {
  const base = `http://127.0.0.1:${run.debugPort}`
  const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) })
  const pages = await response.json()
  const page = pages.find(page => page.type === 'page' && page.url.startsWith('vscode-file:') && page.title.includes('DSH Editor GUI Test'))
  if (!page) throw new Error('Isolated VS Code test window not found on the configured port')
  const endpoint = new URL(page.webSocketDebuggerUrl)
  if (endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== run.debugPort) throw new Error('Unexpected debugger endpoint')
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')) }, 5000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }
  })
  let id = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }
  socket.onclose = () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP disconnected')) }
    pending.clear()
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)) }, 10_000)
    pending.set(requestId, { resolve, reject, timer })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const key = async (key, code, keyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  const click = async ({ x, y }) => {
    for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
  const screenshot = async filename => {
    const { data } = await call('Page.captureScreenshot', { format: 'png' })
    await writeFile(filename, Buffer.from(data, 'base64'))
  }
  return { call, evaluate, key, click, screenshot, close: () => socket.close() }
}
