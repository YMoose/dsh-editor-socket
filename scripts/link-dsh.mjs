/** Offline development against an already installed/built DSH checkout. */
import { readdir, readFile, mkdir, symlink, lstat } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const checkout = process.argv[2]
if (!checkout) throw new Error('Usage: npm run link:dsh -- /path/to/deepseek-harness')
const root = resolve(checkout)
const require = createRequire(join(root, 'package.json'))
const clientRequire = createRequire(join(root, 'packages/client/ui-conversation/package.json'))
async function link(name, target) {
  const dest = resolve('node_modules', name)
  await mkdir(dirname(dest), { recursive: true })
  try { await lstat(dest); return } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(target, dest, 'dir')
}
async function packageAt(directory) {
  let pkg
  try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  await link(pkg.name, directory)
}
for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const pkg of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
    if (pkg.isDirectory()) await packageAt(join(root, 'packages', group.name, pkg.name))
  }
}
for (const pkg of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
  if (pkg.isDirectory()) await packageAt(join(root, 'vendor', pkg.name))
}
for (const name of ['typescript', 'tsx', 'zod', 'react', 'react-dom', '@types/node', '@types/react', '@types/react-dom']) {
  let manifest
  try { manifest = require.resolve(`${name}/package.json`) }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; manifest = clientRequire.resolve(`${name}/package.json`) }
  await link(name, dirname(manifest))
}
const tsxRequire = createRequire(require.resolve('tsx'))
await link('esbuild', dirname(tsxRequire.resolve('esbuild/package.json')))
console.log('Linked local DSH packages and build tools; no DSH files were changed.')
