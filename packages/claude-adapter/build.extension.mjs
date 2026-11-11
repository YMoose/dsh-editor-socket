/**
 * Bundle the VS Code extension entry to a single CJS file.
 *
 * VS Code's extension host requires CommonJS, but this package is authored
 * as ESM (type: module, NodeNext resolution) to match the sibling packages.
 * esbuild bridges the gap: it inlines dsh-editor-plug, dsh-editor-protocol,
 * and the local claude.ts, leaving only `vscode` and Node builtins as externals.
 */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const lib = join(root, 'lib')
await mkdir(lib, { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(lib, 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: false,
  minify: false,
})
