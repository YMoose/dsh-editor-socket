/** Real DSH process restart + compiled VS Code adapter, isolated from all user profiles. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const socketRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adapterPath = resolve(process.argv[2] ?? join(socketRoot, '../vsc-agents-connector/out/src/agents/dsh/index.js'))
await readFile(adapterPath)
const root = await mkdtemp(join(tmpdir(), 'dsh-editor-history-'))
const home = join(root, 'home')
const profile = join(home, 'profiles/web')
for (const directory of [join(profile, 'node_modules'), join(root, 'workspace'), join(root, 'other')]) await mkdir(directory, { recursive: true })
await symlink(socketRoot, join(profile, 'node_modules/dsh-editor-socket'), process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'editor-history-regression', private: true,
  dependencies: { 'dsh-editor-socket': `link:${socketRoot}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-editor-socket'] } },
}))
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')

async function runPhase(phase) {
  const patch = join(root, `${phase}.yml`)
  await writeFile(patch, `- insert:\n    - id: editor-history-fixture\n      name: ${JSON.stringify(join(socketRoot, 'scripts/history-fixture.mjs'))}\n      config:\n        root: ${JSON.stringify(root)}\n        phase: ${phase}\n        adapterPath: ${JSON.stringify(adapterPath)}\n`)
  const log = await open(join(root, `${phase}.log`), 'w', 0o600)
  const child = spawn('dsh', ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: join(root, 'workspace'), detached: process.platform !== 'win32',
    env: { ...process.env, DSH_HOME: home, XDG_STATE_HOME: join(root, 'state') },
    stdio: ['ignore', log.fd, log.fd],
  })
  let exited = false
  let spawnError
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve() }))
  child.once('error', error => { spawnError = error })
  const signal = value => {
    if (exited) return
    if (process.platform === 'win32') child.kill(value)
    else { try { process.kill(-child.pid, value) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  }
  try {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (spawnError) throw spawnError
      try {
        const result = JSON.parse(await readFile(join(root, `${phase}-result.json`), 'utf8'))
        assert.ok(result.ok, result.error)
        console.log(JSON.stringify({ phase, ...result }))
        return
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (exited) throw new Error(`DSH exited before ${phase} completed`)
      await delay(100)
    }
    throw new Error(`Timed out waiting for ${phase}`)
  } finally {
    signal('SIGINT')
    await Promise.race([closed, delay(5000)])
    if (!exited) { signal('SIGKILL'); await closed }
    await log.close()
  }
}
try {
  await runPhase('seed')
  await runPhase('verify')
  await rm(root, { recursive: true, force: true })
  console.log('PASS: real DSH restart → six persisted sessions → workspace connection loads nothing → opened session captures editor context')
} catch (error) {
  console.error(`History regression failed. Isolated artifacts: ${root}`)
  throw error
}
