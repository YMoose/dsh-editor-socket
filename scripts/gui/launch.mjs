/** Launch only the isolated profile described by prepare.mjs. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const [filename, app] = process.argv.slice(2)
if (!filename || !['dsh', 'code'].includes(app)) throw new Error('Usage: node scripts/gui/launch.mjs <run.json> dsh|code')
const run = JSON.parse(await readFile(filename, 'utf8'))
const args = app === 'dsh'
  ? ['--profile', 'web', '--patch', join(run.root, 'test.patch.yml'), '--no-open', '--port', '0']
  : ['--new-window', '--wait', '--user-data-dir', run.vscodeUser, '--extensions-dir', run.extensions,
    `--extensionDevelopmentPath=${run.connectorRoot}`, `--remote-debugging-port=${run.debugPort}`,
    '--disable-workspace-trust', run.workspace]
const child = spawn(app, args, {
  cwd: run.workspace, stdio: 'inherit',
  env: { ...process.env, DSH_HOME: run.home, XDG_STATE_HOME: run.state },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
