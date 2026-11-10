/**
 * Bundle only the DSH dynamic client module.
 *
 * The host half of the socket is emitted by tsc (see tsconfig.json); DSH client
 * modules are closure factories rather than browser ESM imports, so they need a
 * CJS bundle wrapped in the loader call. Paths resolve from this file, not cwd.
 */
import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lib = join(root, 'lib')
await mkdir(lib, { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/client/index.tsx')], outfile: join(lib, 'client.js'),
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
