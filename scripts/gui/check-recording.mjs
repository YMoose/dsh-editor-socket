/** Confirm that a real GUI send carried selected buffer text rather than reading the file. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

if (!process.argv[2]) throw new Error('Usage: node scripts/gui/check-recording.mjs <run.json>')
const run = JSON.parse(await readFile(process.argv[2], 'utf8'))
const entries = (await readFile(join(run.root, 'model-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
const entry = entries.findLast(entry => entry.messages.some(message => JSON.stringify(message).includes('GUI_TEST_SEND:')))
assert.ok(entry, 'Send a message beginning GUI_TEST_SEND: through the DSH composer first')
const prompt = entry.messages.findLastIndex(message => message.source?.kind === 'user' && JSON.stringify(message.content).includes('GUI_TEST_SEND:'))
const source = entry.messages[prompt + 1]
assert.ok(prompt >= 0 && source?.source?.kind === 'editor-socket' && JSON.stringify(source).includes('GUI_UNSAVED_MARKER'), 'The submitted message must be immediately followed by its unsaved editor snapshot')
assert.equal((await readFile(join(run.workspace, 'beta.ts'), 'utf8')).includes('GUI_UNSAVED_MARKER'), false, 'Keep beta.ts unsaved during this test')
console.log(JSON.stringify({ passed: true, modelRequests: entries.length, unsavedSelectionCaptured: true, diskUnchanged: true }, null, 2))
