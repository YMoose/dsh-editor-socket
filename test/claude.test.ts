import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeSelectionChanged, isProcessAlive, parseLockFile, planBridges, readClaudeLocks, selectionSnapshot,
} from 'dsh-editor-socket/claude'
import type { ClaudeLockInfo } from 'dsh-editor-socket/claude'

const lock = (port: number, folder: string, mtimeMs = 0): ClaudeLockInfo => ({
  port, pid: 1, workspaceFolders: [folder], authToken: 'token', mtimeMs,
})

test('lock parsing accepts ws registrations and ignores malformed files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-locks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, '41000.lock'), JSON.stringify({ pid: 1, workspaceFolders: ['/work'], transport: 'ws', authToken: 'token' }))
  await writeFile(join(dir, '41001.lock'), JSON.stringify({ pid: 2, workspaceFolders: [], transport: 'tcp', authToken: 'token' }))
  await writeFile(join(dir, '41002.lock'), JSON.stringify({ pid: 3, workspaceFolders: [] }))
  await writeFile(join(dir, 'not-a-port.lock'), '{}')
  await writeFile(join(dir, '41003.lock'), '{oops')
  assert.deepEqual(readClaudeLocks(dir, () => true).map(item => item.port), [41000])
  assert.deepEqual(readClaudeLocks(dir, () => false), [], 'a lock whose owner process is gone is stale')
  assert.equal(parseLockFile(join(dir, '41000.lock'))?.authToken, 'token')
  assert.equal(parseLockFile(join(dir, '41003.lock')), undefined)
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(2 ** 30), false)
})

test('planning pairs each workspace with one server, preferring exact folders', () => {
  const plan = planBridges([lock(41000, '/work'), lock(41001, '/work/sub'), lock(41002, '/elsewhere')], ['/work', '/work/sub'])
  assert.equal(plan.get('/work')?.url, 'ws://127.0.0.1:41000')
  assert.equal(plan.get('/work/sub')?.url, 'ws://127.0.0.1:41001')
  assert.equal(plan.size, 2)
  assert.equal(planBridges([lock(41000, '/nope')], ['/work']).size, 0)
  // Two windows on the same folder: the most recently touched lock wins.
  const newest = planBridges([lock(41000, '/work', 1), lock(41001, '/work', 2)], ['/work'])
  assert.equal(newest.get('/work')?.url, 'ws://127.0.0.1:41001')
  // An editor opened on a subdirectory still serves the parent workspace.
  assert.equal(planBridges([lock(41000, '/work/sub')], ['/work']).get('/work')?.url, 'ws://127.0.0.1:41000')
})

test('selection conversion shifts 0-based Claude lines to the 1-based wire format', () => {
  const text = 'ode_modules/\r\ndist/\r\ndist-test/\r\n.workbuddy'
  const snapshot = selectionSnapshot({
    text,
    filePath: 'D:\\work\\a.txt',
    selection: { start: { line: 0, character: 1 }, end: { line: 3, character: 10 }, isEmpty: false },
  }, 'D:\\work', 32_768)
  assert.deepEqual(snapshot, {
    path: 'd:/work/a.txt',
    workspace: 'd:/work',
    selection: { start: 1, end: 4, startCharacter: 1, endCharacter: 10, text },
  })
  // An empty caret is a bare file reference, never a one-line range.
  const caret = selectionSnapshot({
    text: '',
    filePath: 'D:\\work\\a.txt',
    selection: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 }, isEmpty: true },
  }, 'D:\\work', 32_768)
  assert.equal(caret.selection, undefined)
  // Oversized text is dropped while the range survives.
  const large = selectionSnapshot({
    text: 'x'.repeat(10),
    filePath: 'D:\\work\\a.txt',
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 }, isEmpty: false },
  }, 'D:\\work', 5)
  assert.equal(large.selection?.text, undefined)
  assert.equal(large.selection?.start, 1)
})

test('selection decoding accepts only the IDE payload shape', () => {
  const decoded = decodeSelectionChanged({
    text: 'x',
    filePath: '/w/a.ts',
    selection: { start: { line: 2, character: 1 }, end: { line: 3, character: 4 }, isEmpty: false },
  })
  assert.deepEqual(decoded?.selection, { start: { line: 2, character: 1 }, end: { line: 3, character: 4 }, isEmpty: false })
  assert.equal(decodeSelectionChanged({ filePath: '/w/a.ts' }), undefined)
  assert.equal(decodeSelectionChanged({ text: 'x', filePath: '/w/a.ts', selection: { start: { line: 1 } } }), undefined)
  assert.equal(decodeSelectionChanged(null), undefined)
})
