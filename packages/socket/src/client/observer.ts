import type { EditorState } from 'dsh-editor-protocol'

export type Request = (method: string, payload: object, signal?: AbortSignal) => Promise<unknown>

/** One mounted input rail owns one cancellable subscription and its reconnect timer. */
export async function observeEditor(
  request: Request, sessionId: string, signal: AbortSignal,
  publish: (state: EditorState | undefined, error: Error | undefined) => void,
): Promise<void> {
  let state: EditorState | undefined
  while (!signal.aborted) {
    try {
      const next = await request(state ? 'watch' : 'state', {
        sessionId, ...(state ? { version: state.version } : {}),
      }, signal) as EditorState
      if (signal.aborted) return
      state = next
      publish(next, undefined)
    } catch (error) {
      if (signal.aborted) return
      publish(undefined, error instanceof Error ? error : new Error(String(error)))
      state = undefined
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, 2000)
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
}
