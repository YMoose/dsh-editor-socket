/** Assert titles in the real VS Code picker, status bar and hover using only GUI input. */
import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connect } from './cdp.mjs'

const [filename, ...args] = process.argv.slice(2)
if (!filename) throw new Error('Usage: node scripts/gui/check-title.mjs <run.json> [expected title] [--untitled|--restored]')
const run = JSON.parse(await readFile(filename, 'utf8'))
const fixture = JSON.parse(await readFile(join(run.root, 'session.json'), 'utf8'))
assert.ok(fixture.title && fixture.untitledSessionId, 'Prepare a fresh run with --titles')
const untitled = args.includes('--untitled')
const restored = args.includes('--restored')
assert.ok(!args.some(arg => arg.startsWith('--') && !['--untitled', '--restored'].includes(arg)), 'Unknown option')
const expectedTitle = untitled ? undefined : args.filter(arg => !arg.startsWith('--')).join(' ') || fixture.title
const sessionId = untitled ? fixture.untitledSessionId : fixture.sessionId
const stage = restored ? 'restored' : untitled ? 'untitled' : expectedTitle === fixture.title ? 'initial' : 'renamed'
const recording = () => readFile(join(run.root, 'model-requests.jsonl'), 'utf8')
const before = await recording()
const cdp = await connect(run)
const bar = "document.getElementById('moose.vsc-agents-connector')"
const rows = "[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(e => e.offsetParent)"
const point = expression => cdp.evaluate(`(() => {
  const e = ${expression}; if (!e || !e.offsetParent) throw Error('GUI target not visible');
  const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
})()`)
async function until(read, description) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}
try {
  await cdp.call('Page.bringToFront')
  await until(() => cdp.evaluate('document.hasFocus()'), 'VS Code focus')
  await cdp.key('Escape', 'Escape', 27)
  if (!restored) {
    await cdp.click(await point(bar))
    const row = `${rows}.find(e => e.querySelector('.label-description')?.textContent === ${JSON.stringify(sessionId)})`
    const entry = await until(() => cdp.evaluate(`(() => {
      const e = ${row}; return e && {label:e.querySelector('.label-name')?.textContent, text:e.innerText};
    })()`), 'the session picker entry')
    assert.equal(entry.label, `[DSH] ${expectedTitle ?? sessionId}`, 'picker must show this session’s current title or ID')
    assert.ok(entry.text.includes(run.workspace), 'picker must identify the matching workspace')
    await cdp.screenshot(join(run.root, 'screenshots', `title-${stage}-picker.png`))
    await cdp.click(await point(row))
    await until(() => cdp.evaluate("!document.querySelector('.quick-input-widget input')?.offsetParent"), 'picker to close')
  }

  // The ID in the accessible tooltip identifies the connected session even
  // when two titles share a prefix; checking only visible text could pass stale UI.
  const status = await until(() => cdp.evaluate(`(() => {
    const e = ${bar}; const hint = e?.getAttribute('aria-label') ?? '';
    return hint.includes(${JSON.stringify(`Connected to DSH session ${sessionId}`)})
      && ${expectedTitle ? `hint.includes(${JSON.stringify(expectedTitle)})` : 'true'}
      && {text:e.innerText.trim(), hint};
  })()`), 'the connected session title')
  if (untitled) {
    assert.equal(status.text, `DSH: ${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`)
    assert.ok(!status.hint.includes(fixture.title), 'untitled sessions must not retain the previous title')
  } else if (Array.from(expectedTitle).length <= 40) {
    assert.equal(status.text, `DSH: ${expectedTitle}`)
  } else {
    const label = status.text.slice('DSH: '.length)
    assert.ok(status.text.startsWith('DSH: ') && label.endsWith('…'), 'long titles should be abbreviated')
    assert.ok(Array.from(label).length <= 40 && expectedTitle.startsWith(label.slice(0, -1)))
  }

  // Open the actual hover, not just its accessibility label.
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 })
  await delay(150)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(bar) })
  const hover = await until(() => cdp.evaluate(`(() => {
    const e = [...document.querySelectorAll('.monaco-hover')].find(e => e.offsetParent && e.innerText.includes(${JSON.stringify(sessionId)}));
    return e?.innerText;
  })()`), 'the status bar hover')
  if (expectedTitle) assert.ok(hover.includes(expectedTitle), 'hover must retain the full title')
  if (untitled) assert.ok(hover.startsWith('Connected to DSH session '), 'hover must not contain a stale title')
  await cdp.screenshot(join(run.root, 'screenshots', `title-${stage}-status.png`))
  assert.equal(await recording(), before, 'title discovery and connection must not invoke the model')
  const result = { stage, expectedTitle: expectedTitle ?? null, sessionId, status: status.text, hover, modelUnchanged: true }
  await appendFile(join(run.root, 'title-checks.jsonl'), JSON.stringify(result) + '\n')
  console.log(JSON.stringify({ stage, pickerChecked: !restored, statusChecked: true, hoverChecked: true, modelUnchanged: true }))
} finally { cdp.close() }
