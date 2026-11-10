/** Create an isolated, disposable GUI test profile. Does not start either application. */
import { mkdtemp, mkdir, readFile, writeFile, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const socketRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const titleTest = process.argv.includes('--titles')
const args = process.argv.slice(2).filter(arg => arg !== '--titles')
const connectorRoot = resolve(args[0] ?? join(socketRoot, '../vsc-agents-connector'))
const debugPort = Number(args[1] ?? 9223)
if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) throw new Error('Use a free debug port between 1024 and 65535')
const connector = JSON.parse(await readFile(join(connectorRoot, 'package.json'), 'utf8'))
if (connector.name !== 'vsc-agents-connector') throw new Error('Pass the vsc-agents-connector checkout')
await access(join(socketRoot, 'packages/socket/lib/client.js'))
await access(join(connectorRoot, 'out/src/extension.js'))

const root = await mkdtemp(join(tmpdir(), 'dsh-editor-gui-'))
const run = {
  root, socketRoot, connectorRoot, debugPort,
  workspace: join(root, 'workspace'), home: join(root, 'dsh-home'), state: join(root, 'state'),
  vscodeUser: join(root, 'vscode'), extensions: join(root, 'extensions'),
}
const profile = join(run.home, 'profiles/web')
for (const directory of [run.workspace, join(profile, 'node_modules'), join(run.vscodeUser, 'User'), join(root, 'screenshots')]) {
  await mkdir(directory, { recursive: true })
}
await writeFile(join(run.workspace, 'alpha.ts'), 'export function greet(name: string): string {\n  const message = `Hello, ${name}`\n  return message\n}\n\nexport const version = 1\n')
await writeFile(join(run.workspace, 'beta.ts'), 'export function sum(a: number, b: number): number {\n  return a + b\n}\n')
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-editor-gui-test', private: true,
  dependencies: { 'dsh-editor-socket': `link:${socketRoot}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-editor-socket'] } },
}, null, 2))
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
await symlink(socketRoot, join(profile, 'node_modules/dsh-editor-socket'), process.platform === 'win32' ? 'junction' : 'dir')
// JSON strings are valid YAML scalars, including paths containing spaces.
await writeFile(join(root, 'test.patch.yml'), `- insert:\n    - id: editor-gui-fixture\n      name: ${JSON.stringify(join(socketRoot, 'scripts/gui/fixture.mjs'))}\n      config:\n        workspace: ${JSON.stringify(run.workspace)}\n        output: ${JSON.stringify(root)}\n        titleTest: ${titleTest}\n`)
await writeFile(join(run.vscodeUser, 'User/settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
  'window.title': 'DSH Editor GUI Test - ${activeEditorShort}',
  'editor.autoIndent': 'none', 'editor.formatOnType': false,
}, null, 2))
await writeFile(join(root, 'run.json'), JSON.stringify(run, null, 2))
console.log(join(root, 'run.json'))
