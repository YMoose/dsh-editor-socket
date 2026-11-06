/** Drive real VS Code mouse/keyboard input; never call the adapter or socket directly. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const [filename, action, ...args] = process.argv.slice(2)
if (!filename || !action) throw new Error('Usage: node scripts/gui/vscode.mjs <run.json> inspect|command|open|enter|escape|file|select|unsaved|screenshot [args]')
const run = JSON.parse(await readFile(filename, 'utf8'))
const cdp = await connect(run)
const control = process.platform === 'darwin' ? 4 : 2
const settle = () => new Promise(resolve => setTimeout(resolve, 400))
try {
  if (!['inspect', 'screenshot'].includes(action)) await cdp.call('Page.bringToFront')
  if (action === 'command' || action === 'open') {
    await cdp.key('p', 'KeyP', 80, action === 'command' ? control | 8 : control)
    const deadline = Date.now() + 3000
    while (!await cdp.evaluate("!!document.querySelector('.quick-input-widget input')?.offsetParent")) {
      if (Date.now() >= deadline) throw new Error('Quick input did not open; dismiss any welcome/login dialog first')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await cdp.call('Input.insertText', { text: args.join(' ') })
  } else if (action === 'enter') await cdp.key('Enter', 'Enter', 13)
  else if (action === 'escape') await cdp.key('Escape', 'Escape', 27)
  else if (action === 'file') {
    const box = await cdp.evaluate(`(() => {
      const element = [...document.querySelectorAll('.explorer-item .label-name')].find(e => e.textContent === ${JSON.stringify(args[0])});
      if (!element) throw Error('File not visible in Explorer');
      const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`)
    await cdp.click(box)
  } else if (action === 'select') {
    const [start, end] = args.map(Number)
    if (![start, end].every(value => Number.isInteger(value) && value >= 1) || end <= start) throw new Error('Use 1-based start and exclusive end lines, e.g. select 2 4')
    const points = await cdp.evaluate(`(() => {
      const lines = [...document.querySelectorAll('.editor-instance .view-line')];
      return [${start - 1}, ${end - 1}].map(i => {if(!lines[i])throw Error('Line not visible');const r=lines[i].getBoundingClientRect();return {x:r.x+1,y:r.y+r.height/2}});
    })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...points[0], button: 'left', buttons: 1, clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points[1], button: 'left', buttons: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...points[1], button: 'left', buttons: 0, clickCount: 1 })
  } else if (action === 'unsaved') {
    const box = await cdp.evaluate(`(() => {const r=document.querySelector('.editor-instance .view-line').getBoundingClientRect();return {x:r.x+10,y:r.y+r.height/2}})()`)
    await cdp.click(box)
    await cdp.key('a', 'KeyA', 65, control)
    await cdp.call('Input.insertText', { text: '// GUI_UNSAVED_MARKER\nexport function sum(a: number, b: number): number {\n  return a + b + 42\n}\n' })
    await cdp.key('a', 'KeyA', 65, control)
  } else if (action === 'screenshot') await cdp.screenshot(join(run.root, 'screenshots', 'vscode.png'))
  else if (action !== 'inspect') throw new Error('Unknown action')
  await settle()
  if (action !== 'screenshot') console.log(await cdp.evaluate('document.body.innerText'))
} finally { cdp.close() }
