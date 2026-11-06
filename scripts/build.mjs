import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await mkdir('lib', { recursive: true })
await build({
  entryPoints: ['src/index.ts', 'src/protocol.ts', 'src/plug.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  packages: 'external', outdir: 'lib',
})
// DSH dynamic client modules are closure factories, not browser ESM imports.
await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
