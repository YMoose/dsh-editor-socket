# Editor socket protocol v2

Version 2 removes `pin`, pinned state, `maxPinned`, and the `pin`/`remove`/`reset`
composer actions. Upgrade both socket and editor SDK together. Discovery filters
incompatible versions; connect also checks the version before taking a lease.

## Transport and discovery

Each activation binds an ephemeral `http://127.0.0.1:<port>` listener and writes
`<instanceId>.json` in the discovery directory, mode `0600`:

```json
{"protocolVersion":2,"instanceId":"uuid","pid":1234,"url":"http://127.0.0.1:12345","token":"64-hex-characters"}
```

Use the exported `discoverSockets()` helper, which checks file ownership, permissions,
size, symlinks and loopback addresses before returning credentials. A registration
can outlive a crashed process: probe it, skip unreachable instances, and never send
its token to a different address or follow redirects. Normal teardown removes the
instance's own file. Tokens rotate on every activation.

All editor calls use `POST <url>/editor-socket/<method>`, `Content-Type: application/json`,
and `Authorization: Bearer <token>`. Browser Origin headers are rejected. There is no
CORS allowance. This is a local same-user interface, not a general DSH model/session API.

The dsh composer uses owner-only native `/api/editor-socket/<method>` Fetch routes,
through `connection.rpc.call('/api', 'editor-socket/<method>', payload, signal)`.
These work with Web HTTP and Desktop IPC and use native DSH authentication.

Request and response envelopes:

```json
{"type":"client-request","rpcId":"unique-id","method":"update","payload":{}}
```

```json
{"type":"server-response","rpcId":"unique-id","result":{"ok":true,"value":{}}}
```

```json
{"type":"server-response","rpcId":"unique-id","result":{"ok":false,"error":{"code":"editor-socket/disconnected","message":"Reconnect the editor before sending updates","details":{}}}}
```

Malformed requests use HTTP 400; unauthenticated requests 401; forbidden origin/host
403; unknown paths 404; non-POST/non-JSON requests 415; oversized bodies 413.
Valid business errors use HTTP 200 with `result.ok: false`.

## Operations

| Method | Payload | Result |
| --- | --- | --- |
| `info` | `{}` | `{protocolVersion, limits}` |
| `sessions` | `{}` | Ordinary `{sessionId, directory, status, title?}` entries, including persisted sessions |
| `connect` | `{sessionId, clientId, editor, workspace}` | `{connectionId, heartbeatMs, state}` |
| `state` | `{sessionId}` | Current editor state |
| `watch` | `{sessionId, version}` | State immediately if changed, otherwise on change or after 25 s |
| `update` | Mutation + `snapshot` | State; replace live reference |
| `clear` | Mutation | State; clear live |
| `heartbeat` | Mutation | State; renew lease |
| `disconnect` | Mutation | State; release lease, clear live |
| `edit` | `{sessionId, version, action}` | State; composer action `clear` |

`sessions` uses DSH's native Session list when `sessionController` is mounted.
Listing does not activate Agents. Persisted entries have `status: "unloaded"`;
Subagent-owned entries, entries without a working directory, archived entries
(when the Workspace registry is available), and unloaded blank placeholders are
excluded. Live blank sessions remain connectable before their first prompt.
Minimal hosts without that API retain live-Agent discovery.

`title` comes from the current projection for a loaded session, or DSH's persisted
projection hints for an unloaded session. It is omitted before a title exists or
when no title/cache is available; editors should fall back to the session ID.

`connect` rechecks the selected entry and workspace before using DSH's native
Session resolver. Only the selected session is resumed; its effective directory
is checked again before granting a lease. Removed or unresumable sessions return
`session-unavailable`, and cross-workspace requests return `workspace-mismatch`.
Connecting does not submit a user message or create a replacement conversation.

Mutation fields are `{sessionId, connectionId, sequence}`. Sequence starts at 1
and increases for every mutation, including heartbeat. Old/duplicate sequences
are ignored and return current state; invalid commands do not consume sequence
numbers. Serialize operations so clear cannot overtake update. Do not keep
mutating after a failed connection; reconnect explicitly.

One editor window leases a session at a time. Reconnecting with the same stable
`clientId` rotates the connection ID and clears live state; other windows receive
`busy`. Heartbeat every `heartbeatMs` (default 10 s); expiration (default 30 s)
clears live state. A fresh activation has no live leases or references.

`workspace` must exactly match the session directory after lexical path normalization.
Files must be within that directory. These are host filesystem paths, not URIs;
symlinks are not resolved and files are not read. No cross-host path mapping exists.

```json
{
  "path":"/work/project/src/main.ts",
  "workspace":"/work/project",
  "selection":{"start":10,"end":15,"text":"optional selected buffer text"}
}
```

Lines are 1-based and inclusive. Selection may be omitted. Text is optional and
limited to 32768 UTF-8 bytes by default; a file reference does not include its contents.

State is `{sessionId, version, connected, editor, live}`. `live` is a snapshot
or null. Version is opaque and includes the server
instance. Composer edits use compare-and-set; a stale version returns `conflict`.
Watch calls must be canceled on unmount/session switch. The default watcher limit is 128.

## Prompt semantics

Only ordinary `source.kind === 'user'` inbox insertions capture context. Live updates
and clears never create prompts or invoke the model. Each accepted user message
freezes the current live reference; live state remains available for later messages.
Clearing removes it from future captures until the editor sends another update. Captures are logged as ignorable plugin records and
reconstructed by a host-only session projection. Discarded inbox messages release
their captures; plugin reload recovers queued captures.

Immediately before a model step, correlated captures become ordinary persisted
user-role context after the corresponding user message. Values are rendered as JSON
reference data, explicitly not instructions. Historical context remains in normal
DSH conversation history after sending, even when the current editor state is cleared.

Useful business errors: `invalid`, `workspace-mismatch`, `session-unavailable`,
`busy`, `disconnected`, `capacity`, `selection-too-large`, `conflict`,
`closed`, `internal`, all prefixed with `editor-socket/`.
