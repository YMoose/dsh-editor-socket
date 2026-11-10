/** Editor-side SDK: the plug client and local socket discovery, with no DSH or VS Code imports. */
export { EditorPlug } from './plug.ts'
export type { PlugOptions } from './plug.ts'
export { discoverSockets, defaultDiscoveryDirectory } from './discovery.ts'
export type { Registration } from './discovery.ts'
