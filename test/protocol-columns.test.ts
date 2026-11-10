import test from 'node:test'
import assert from 'node:assert/strict'
import { label, snapshotOf } from 'dsh-editor-protocol'
import type { EditorSnapshot, ProtocolLimits } from 'dsh-editor-protocol'

const limits: ProtocolLimits = {
  maxSelectionBytes: 32_768, maxWorkspaces: 32, leaseMs: 30_000, watchMs: 25_000, maxWatchers: 128,
}
const base = { path: '/work/a.ts', workspace: '/work' }
const snap = (selection: object) => snapshotOf({ ...base, selection }, '/work', limits)

test('snapshotOf preserves both character offsets', () => {
  assert.deepEqual(snap({ start: 10, end: 12, startCharacter: 3, endCharacter: 7 }).selection, {
    start: 10, end: 12, startCharacter: 3, endCharacter: 7,
  })
  assert.deepEqual(snap({ start: 10, end: 10, startCharacter: 0, endCharacter: 0 }).selection, {
    start: 10, end: 10, startCharacter: 0, endCharacter: 0,
  })
})

test('snapshotOf accepts a zero character offset but keeps lines one-based', () => {
  assert.equal(snap({ start: 1, end: 1, startCharacter: 0, endCharacter: 4 }).selection?.startCharacter, 0)
  assert.throws(() => snap({ start: 0, end: 1 }), /selection\.start/)
})

test('snapshotOf rejects half-specified character pairs', () => {
  assert.throws(() => snap({ start: 10, end: 12, startCharacter: 3 }), { code: 'invalid-selection' })
  assert.throws(() => snap({ start: 10, end: 12, endCharacter: 3 }), { code: 'invalid-selection' })
})

test('snapshotOf rejects negative or non-integer characters', () => {
  assert.throws(() => snap({ start: 10, end: 12, startCharacter: -1, endCharacter: 2 }), /startCharacter/)
  assert.throws(() => snap({ start: 10, end: 12, startCharacter: 1, endCharacter: -1 }), /endCharacter/)
  assert.throws(() => snap({ start: 10, end: 12, startCharacter: 1.5, endCharacter: 2 }), /startCharacter/)
})

test('snapshotOf enforces character order within a single line', () => {
  assert.throws(() => snap({ start: 10, end: 10, startCharacter: 8, endCharacter: 3 }), { code: 'invalid-selection' })
  assert.doesNotThrow(() => snap({ start: 10, end: 10, startCharacter: 3, endCharacter: 8 }))
  // Across lines the line numbers carry the order; characters may restart.
  assert.doesNotThrow(() => snap({ start: 10, end: 12, startCharacter: 40, endCharacter: 2 }))
})

test('snapshotOf stays backward compatible with line-only selections', () => {
  assert.deepEqual(snap({ start: 10, end: 15 }).selection, { start: 10, end: 15 })
  assert.deepEqual(snap({ start: 10, end: 10, text: 'x' }).selection, { start: 10, end: 10, text: 'x' })
  assert.deepEqual(snapshotOf({ ...base }, '/work', limits), { path: '/work/a.ts', workspace: '/work' })
})

test('label renders line-only and column-aware variants', () => {
  const snapshot = (selection?: EditorSnapshot['selection']): EditorSnapshot =>
    ({ path: '/work/src/a.ts', workspace: '/work', ...(selection === undefined ? {} : { selection }) })
  assert.equal(label(snapshot({ start: 10, end: 10 })), 'src/a.ts#L10')
  assert.equal(label(snapshot({ start: 10, end: 15 })), 'src/a.ts#L10-L15')
  assert.equal(label(snapshot({ start: 10, end: 10, startCharacter: 5, endCharacter: 12 })), 'src/a.ts#L10:5-L10:12')
  assert.equal(label(snapshot({ start: 10, end: 15, startCharacter: 5, endCharacter: 2 })), 'src/a.ts#L10:5-L15:2')
  assert.equal(label(snapshot()), 'src/a.ts')
})
