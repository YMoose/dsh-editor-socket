# Troubleshooting: when the DSH web UI doesn't react

Symptoms this guide covers: the editor socket host side is reachable (`/editor-socket/sessions` returns data over `curl`), the VS Code side reports `connected: true`, but the DSH web composer shows nothing — no `Editor context` chip above the input, no Trajectory entries for editor captures.

These failures split cleanly into three layers. Check each in order; do not skip ahead.

## Layer 1 — host plugin loaded?

The host half of `dsh-editor-socket` is mounted through the profile's bundle list (`dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`). When it loads, it opens a loopback HTTP listener and writes a registration file.

```sh
# 1. Registration file exists and points at a live PID?
ls -lat ~/.local/state/dsh-editor-socket/
cat ~/.local/state/dsh-editor-socket/<newest>.json
# {"protocolVersion":3,"instanceId":"…","pid":N,"url":"http://127.0.0.1:PORT","token":"…"}

# 2. The PID is alive and matches the dsh process you expect?
ps -o pid,etime,cmd -p <pid>

# 3. The host endpoint answers?
TOKEN=$(jq -r .token ~/.local/state/dsh-editor-socket/<newest>.json)
URL=$(jq -r .url ~/.local/state/dsh-editor-socket/<newest>.json)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"1","method":"editor-socket/sessions","payload":{}}' \
  "$URL/editor-socket/sessions" | jq .
```

A 401 means you forgot the `Authorization: Bearer` header. A 415 means you sent GET; the endpoint is POST-only with a JSON envelope. A 404 means the socket host is not actually mounted in this `dsh` process — check the profile's bundle list and that the `dsh-editor-socket` package is resolvable from the profile's `node_modules`.

## Layer 2 — web client bundle registered?

The browser half (`EditorDock`, the chip above the composer input) is loaded dynamically by `@deepseek-ai/dsh-client-modules`, which scans the host Loader for entries whose nearest `package.json` declares `dsh.client`. If the row is missing, the chip never renders.

Check from the browser console:

```js
// In DevTools on the DSH web tab
window.__DSH_BOOT__.entries.filter(e => e.id.includes('editor'))
// Expected: [{id: 'dsh-editor-socket', url: 'plugins/??dsh-editor-socket/client.js&rev=…', …}]
// Bad: []
```

An empty array is the smoking gun. Two distinct causes produce it:

### 2a. Monorepo layout hides `dsh.client` from `nearestPackage`

`dsh-client-modules` resolves the host entry's import URL to a file, then walks **up** from `dirname(file)` until it finds a `package.json` whose `name` matches the Loader entry name — and **stops at the first match**. If your plugin is a monorepo:

```
dsh-editor-socket/                  ← root package.json has dsh.client
  packages/socket/package.json      ← name is also "dsh-editor-socket", but no dsh field
  packages/socket/lib/index.js      ← the entry file the Loader resolved
```

…the walk stops at `packages/socket/package.json` (name matches), never reaches the root, finds no `dsh.client`, and the row is silently dropped. The host half still works — only the browser half is missing.

**Fix.** Put a `dsh.client` declaration on the **sub-package** that owns the entry file, not just the root:

```jsonc
// packages/socket/package.json
{
  "name": "dsh-editor-socket",
  // …
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

Keep `dsh.bundle.patch` on the **root** only — the profile composer reads it through `createRequire(profile).resolve('<pkg>/package.json')`, which lands on the root via the `./package.json` export. Copying the bundle patch into the sub-package would double-apply it.

Verify statically before restarting:

```sh
node -e '
const { createRequire } = require("node:module");
const path = require("node:path"), fs = require("node:fs");
const req = createRequire("/home/cambricon/.dsh/profiles/web/x.js");
const entry = req.resolve("dsh-editor-socket");
let d = path.dirname(entry);
while (true) {
  const c = path.join(d, "package.json");
  if (fs.existsSync(c)) {
    const p = JSON.parse(fs.readFileSync(c, "utf8"));
    if (p.name === "dsh-editor-socket") {
      console.log("manifest:", c);
      console.log("dsh.client:", JSON.stringify(p.dsh && p.dsh.client));
      break;
    }
  }
  const up = path.dirname(d); if (up === d) break; d = up;
}'
```

Before the fix this prints `dsh.client: undefined`; after, it prints the full object.

**Reload caveat.** `client-modules` only re-reads a manifest when the host Loader entry restarts. A `package.json` edit alone is invisible to a running `dsh web`; restart the profile (`systemctl --user restart dsh-web` for systemd-managed, or `dsh --profile web` again) before re-testing.

### 2b. The host plugin never registers its `/api/editor-socket/*` routes

The socket host serves the editor's own listener on a random 4xxxx port — that part is independent. Separately, the **web** UI talks to the host through DSH's shared API gateway at `/api/editor-socket/<method>`, which the host plugin registers via the `connection` service:

```ts
// packages/socket/src/index.ts
const connection = ctx.get('connection')
if (connection) {
  for (const method of METHODS) {
    connection.fetch.register({
      path: `/api/editor-socket/${method}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => { /* … */ },
    })
  }
}
```

If `inject` does not list `connection`, `ctx.get('connection')` may run before the service is mounted and return `undefined`; the entire `for` loop is then skipped and every browser-side `state` / `watch` / `edit` call returns a plain `404 not found` from the gateway — even though the editor's own loopback socket works fine and `connected: true` is reported by the editor.

**Fix.** Declare the dependency explicitly so cordis orders activation correctly:

```ts
export const inject = ['agents', 'workingDirectory', 'sessionProjections', 'connection']
```

Verify after restarting the profile:

```js
// DevTools on the DSH web tab
const r = await fetch('/api/editor-socket/state', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method: 'editor-socket/state',
    payload: { sessionId: '<any live sessionId>' }
  })
});
r.status  // 200 once registered, 404 if the route was skipped
```

## Layer 3 — the chip renders but says "Editor context is unavailable. Reconnecting…"

The `EditorDock` is mounted and polling, but the host reports no live editor for the session's directory. Causes, in order:

1. **The editor is connected to a stale instance.** Each `dsh web` restart picks a new ephemeral port and writes a new registration file. Editors that connected before the restart still hold the old URL. Either restart the editor (VS Code window) or re-run **VSC Agents: Connect to Local Service**.
2. **The session's cwd doesn't match the editor's workspace.** The lease is directory-scoped; if the DSH session was started in a different directory than the editor's workspace folder, `state.live` stays `null` even with a healthy connection. Check `workspace` in the `state` response against the session's actual cwd.
3. **Stale registration files pollute discovery.** Old `*.json` files pointing at dead PIDs make `discoverSockets()` return unreachable URLs first. Prune them (see the loop in § Layer 1).

## Quick reference: expected state when everything works

Browser console on a healthy session:

```js
window.__DSH_BOOT__.entries.length                       // 75 (74 stock + dsh-editor-socket)
window.__DSH_BOOT__.entries.find(e => e.id === 'dsh-editor-socket')
// {id: 'dsh-editor-socket', url: 'plugins/??dsh-editor-socket/client.js&rev=…', inject: […]}

document.querySelectorAll('[data-editor-socket]').length // 1

// Manual state probe
(await (await fetch('/api/editor-socket/state', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(),
    method: 'editor-socket/state',
    payload: { sessionId: '<sessionId>' } })
})).json()).result.value
// { workspace: '/home/cambricon/yzh', version: '…:N',
//   connected: true, editor: 'VS Code',
//   live: { path: '…', selection: { start, end, text } } }
```

The composer shows a chip like `README.md:23-29 ×` above the input whenever the editor has a focused file or selection.
