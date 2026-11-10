import * as React from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { EditorState } from 'dsh-editor-protocol'
import { observeEditor } from './observer.ts'
import type { Request } from './observer.ts'
import type { NS, Key } from './locales.ts'

export interface DockInjected {
  readonly editorSessionId: string
  readonly requestEditor: Request
}
type Props = PropsRuntime<'conversation.input.overlay'> & InjectFace<DockInjected> & PropsLocale<typeof NS>
// DSH 0.2.2's overlay is normally a zero-height absolute anchor. While our
// rail is present, let it size naturally. Keep its top at the card's top so
// sibling slash/mention menus retain their bottom: 100% positioning anchor.
// Public data attributes avoid depending on generated host CSS class names.
const styles = `
[data-composer-card] > [data-composer-overlay]:has([data-editor-socket]) {
  position: relative; inset: auto; height: auto; min-width: 0; margin-top: -8px;
}
[data-editor-socket] { box-sizing: border-box; min-width: 0; padding: 8px 12px 0; font-size: 12px; line-height: 20px; }
[data-editor-socket] .editor-socket-chip {
  display: inline-flex; align-items: center; max-width: 100%; box-sizing: border-box;
  gap: 6px; padding: 1px 3px 1px 8px; border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 6px; color: var(--dsw-alias-label-secondary, inherit);
}
[data-editor-socket] .editor-socket-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
[data-editor-socket] .editor-socket-range { flex: none; margin-left: -6px; }
[data-editor-socket] button {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px;
  background: transparent; color: inherit; cursor: pointer;
}
[data-editor-socket] button:hover { background: var(--dsw-alias-interactive-bg-hover, #8882); }
[data-editor-socket] button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
[data-editor-socket] button:disabled { opacity: .5; cursor: wait; }
[data-editor-socket] [role=status] { overflow-wrap: anywhere; }
`

/** Presentation can also be rendered independently for a client smoke test. */
export function EditorReferences({ state, pending, error, t, edit }: {
  state?: EditorState; pending: boolean; error?: string;
  t: (key: Key) => string;
  edit: (action: 'clear') => void;
}) {
  if (!error && !state?.live) return null
  const live = state?.live
  const range = live?.selection
  const lines = range ? `:${range.start}${range.end === range.start ? '' : `-${range.end}`}` : ''
  return <section aria-label={t('title')} data-editor-socket>
    <style>{styles}</style>
    {error && <div role="status">{error}</div>}
    {live && <div className="editor-socket-chip" title={`${live.path}${lines}\n${t('hint')}`}>
      <span className="editor-socket-name">{live.path.split('/').pop()}</span>
      {lines && <span className="editor-socket-range">{lines}</span>}
      <button type="button" disabled={pending} onClick={() => edit('clear')} aria-label={t('clear')} title={t('clearHint')}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>}
  </section>
}

export function EditorDock({ editorSessionId, requestEditor, t }: Props) {
  const [state, setState] = React.useState<EditorState>()
  const [error, setError] = React.useState<string>()
  const [pending, setPending] = React.useState(false)
  React.useEffect(() => {
    const abort = new AbortController()
    setState(undefined)
    setError(undefined)
    void observeEditor(requestEditor, editorSessionId, abort.signal, (next, failure) => {
      setState(next)
      setError(failure ? t('unavailable') : undefined)
    })
    return () => abort.abort()
  }, [editorSessionId, requestEditor, t])
  const edit = (action: 'clear') => {
    if (!state || pending) return
    setPending(true)
    void requestEditor('edit', { sessionId: editorSessionId, version: state.version, action })
      .then(() => { setError(undefined) }, error => { setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setPending(false) })
  }
  return <EditorReferences state={state} pending={pending} error={error} t={t} edit={edit} />
}
