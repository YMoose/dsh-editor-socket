import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorReferences } from '../src/client/Dock.tsx'
import { observeEditor } from '../src/client/observer.ts'
import { zh } from '../src/client/locales.ts'
import type { EditorState } from '../src/protocol.ts'

const state: EditorState = {
  sessionId: 'a', version: 'v1', editor: 'VS Code', connected: true,
  live: { path: '/tmp/<script>.ts', workspace: '/tmp', selection: { start: 2, end: 4 } },
}
test('composer renders escaped file ranges and controls, and remains empty without references', () => {
  const props = { state, pending: false, t: (key: keyof typeof zh) => zh[key], edit: () => {} }
  const html = renderToStaticMarkup(createElement(EditorReferences, props))
  assert.match(html, /&lt;script&gt;\.ts<\/span><span[^>]*>:2-4/)
  assert.match(html, /aria-label="清除当前引用"/)
  assert.equal((html.match(/<button /g) ?? []).length, 1)
  assert.doesNotMatch(html, /固定引用|<small/)
  assert.doesNotMatch(html, /<script>/)
  assert.equal(renderToStaticMarkup(createElement(EditorReferences, { ...props, state: undefined })), '')
})

test('composer observer switches to long polling and never publishes after unmount', async () => {
  const abort = new AbortController()
  const methods: string[] = []
  const published: EditorState[] = []
  await observeEditor(async (method, payload, signal) => {
    methods.push(method)
    assert.equal(signal, abort.signal)
    if (method === 'state') return state
    assert.deepEqual(payload, { sessionId: 'a', version: 'v1' })
    abort.abort()
    return { ...state, version: 'v2' }
  }, 'a', abort.signal, next => { if (next) published.push(next) })
  assert.deepEqual(methods, ['state', 'watch'])
  assert.deepEqual(published, [state])
})
