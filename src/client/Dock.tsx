import * as React from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { label } from '../protocol.ts'
import type { EditorSnapshot, EditorState } from '../protocol.ts'
import { observeEditor } from './observer.ts'
import type { Request } from './observer.ts'
import type { NS, Key } from './locales.ts'

export interface DockInjected {
  readonly editorSessionId: string
  readonly requestEditor: Request
}
type Props = PropsRuntime<'conversation.input.dock'> & InjectFace<DockInjected> & PropsLocale<typeof NS>
const row: CSSProperties = { display: 'flex', gap: '0.5em', alignItems: 'center', flexWrap: 'wrap' }
const chip: CSSProperties = { border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', borderRadius: '6px', padding: '0.25em 0.5em', maxWidth: '100%' }
const button: CSSProperties = { color: 'inherit', background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', borderRadius: '4px', padding: '0.15em 0.4em', cursor: 'pointer' }
// Dock slots sit outside InputBar's centered wrapper. Share its width axis explicitly.
const dock: CSSProperties = {
  boxSizing: 'border-box', flex: 'none',
  width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))',
  maxWidth: 'var(--dsh-composer-card-max-width, 952px)',
  margin: '0 auto', padding: '0 14px', fontSize: '0.85em',
}

/** Presentation can also be rendered independently for a client smoke test. */
export function EditorReferences({ state, pending, error, t, edit }: {
  state?: EditorState; pending: boolean; error?: string;
  t: (key: Key) => string;
  edit: (action: string, id?: string) => void;
}) {
  if (!error && !state?.live && !state?.pinned.length) return null
  const reference = (snapshot: EditorSnapshot) => <code style={{ overflowWrap: 'anywhere' }} title={snapshot.path}>{label(snapshot)}</code>
  return <section aria-label={t('title')} style={dock}>
    {error && <div role="status">{error}</div>}
    <div style={row}>
      {state?.live && <div style={{ ...row, ...chip }}>
        <span>{t('live')}</span>{reference(state.live)}
        <button type="button" style={button} disabled={pending} onClick={() => edit('pin')}>{t('pin')}</button>
        <button type="button" style={button} disabled={pending} onClick={() => edit('clear')} aria-label={t('clear')}>×</button>
      </div>}
      {state?.pinned.map(item => <div key={item.id} style={{ ...row, ...chip }}>
        <span>{t('pinned')}</span>{reference(item.snapshot)}
        <button type="button" style={button} disabled={pending} onClick={() => edit('remove', item.id)} aria-label={t('remove')}>×</button>
      </div>)}
      {!!state?.pinned.length && <button type="button" style={button} disabled={pending} onClick={() => edit('reset')}>{t('reset')}</button>}
    </div>
    {(state?.live || !!state?.pinned.length) && <small style={{ display: 'block', marginTop: '4px', color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('hint')}</small>}
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
  const edit = (action: string, id?: string) => {
    if (!state || pending) return
    setPending(true)
    void requestEditor('edit', { sessionId: editorSessionId, version: state.version, action, ...(id ? { id } : {}) })
      .then(() => { setError(undefined) }, error => { setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setPending(false) })
  }
  return <EditorReferences state={state} pending={pending} error={error} t={t} edit={edit} />
}
