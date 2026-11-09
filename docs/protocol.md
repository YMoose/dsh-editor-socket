# Editor socket protocol v3

Version 3 changes the connection unit from session to working directory. `connect`
no longer names a session and never resumes one; leases, live references, state
and mutations are keyed by `workspace`. `state`/`watch`/`edit` still accept a
`sessionId` because the dsh composer knows only its session; the host resolves it
to the session's current working directory. `maxPinned`-era v1 pin operations
remain gone. Upgrade both socket and editor SDK together. Discovery filters
incompatible versions; connect also checks the version before taking a lease.

## Transport and discovery

Each activation binds an ephemeral `http://127.0.0.1:<port>` listener and writes
`<instanceId>.json` in the discovery directory, mode `0600`:

```json
{"protocolVersion":3,"instanceId":"uuid","pid":1234,"url":"http://127.0.0.1:12345","token":"64-hex-characters"}
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
| `sessions` | `{}` | `{sessionId, directory, status, title?}` entries, including persisted sessions |
| `connect` | `{clientId, editor, workspace}` | `{connectionId, heartbeatMs, state}` |
| `state` | `{sessionId}` | Editor state of that session's working directory |
| `watch` | `{sessionId, version}` | State immediately if changed, otherwise on change or after 25 s |
| `update` | Mutation + `snapshot` | State; replace live reference |
| `clear` | Mutation | State; clear live |
| `heartbeat` | Mutation | State; renew lease |
| `disconnect` | Mutation | State; release lease, clear live |
| `edit` | `{sessionId, version, action}` | State; composer action `clear` |

`sessions` uses DSH's native Session list when `sessionController` is mounted.
Listing is read-only display data for editors: it never activates Agents, and
connection no longer consumes it. Persisted entries have `status: "unloaded"`;
Subagent-owned entries, entries without a working directory, archived entries
(when the Workspace registry is available), and unloaded blank placeholders are
excluded. Live blank sessions remain listed so users can attach before their
first prompt. Minimal hosts without that API retain live-Agent discovery.
`title` comes from the current projection for a loaded session, or DSH's persisted
projection hints for an unloaded session. It is omitted before a title exists or
when no title/cache is available; editors should fall back to the session ID.

`connect` takes only `{clientId, editor, workspace}`. The workspace must be an
absolute host path that exists as a directory when the editor connects, checked
before a lease is granted; anything else returns `workspace-mismatch`. Connecting
submits no user message, resumes no session, and creates no replacement
conversation. Sessions in the directory — loaded later by the user, or created
after the connection — are covered automatically because capture resolves each
session's live working directory at message time.

Editor-side mutations (`update`, `clear`, `heartbeat`, `disconnect`) carry
`{workspace, connectionId, sequence}`. Sequence starts at 1 and increases for
every mutation, including heartbeat. Old/duplicate sequences are ignored and
return current state; invalid commands do not consume sequence numbers. Serialize
operations so clear cannot overtake update. Do not keep mutating after a failed
connection; reconnect explicitly.

Composer-side calls (`state`, `watch`, `edit`) carry `sessionId`. The host maps
the session to its current working directory, so a session that changes
directories mid-flight simply observes another directory's state. Unknown or
unloaded sessions report an empty state with `connected: false` and wait out the
watch window instead of spinning.

One editor window leases a workspace at a time. Reconnecting with the same stable
`clientId` rotates the connection ID and clears live state; other windows receive
`busy`. Heartbeat every `heartbeatMs` (default 10 s); expiration (default 30 s)
clears live state. Session creation and disposal do not affect the lease. A fresh
activation has no live leases or references.

`workspace` must be an absolute host path and is matched lexically after
normalization (backslashes, `.` and `..`, trailing slashes, Windows drive casing).
Files must be within that directory. Symlinks are not resolved and files are not
read; the directory itself is only checked for existence and type at connect
time. No cross-host path mapping exists.

```json
{
  "path":"/work/project/src/main.ts",
  "workspace":"/work/project",
  "selection":{"start":10,"end":15,"text":"optional selected buffer text"}
}
```

Lines are 1-based and inclusive. Selection may be omitted. Text is optional and
limited to 32768 UTF-8 bytes by default; a file reference does not include its contents.

State is `{workspace, version, connected, editor, live}`. `workspace` is the
observed directory, empty for sessions without one. `live` is a snapshot or null.
Version is opaque and includes the server instance. Composer edits use
compare-and-set; a stale version returns `conflict`. Watch calls must be canceled
on unmount/session switch. The default watcher limit is 128.

## Prompt semantics

Only ordinary `source.kind === 'user'` inbox insertions capture context, in
whatever DSH session they arrive. At that moment the host resolves the session's
current working directory and freezes that directory's live reference into the
session's own log; two sessions in one directory each freeze their own copy when
their users send. Live updates and clears never create prompts or invoke the
model. Subagent child sessions inherit their parent's directory and therefore
also capture when they receive user-kind input; discovery still hides them from
editor pickers. Clearing removes the reference from future captures until the
editor sends another update. Captures are logged as ignorable plugin records and
reconstructed by a host-only session projection. Discarded inbox messages release
their captures; plugin reload recovers queued captures.

Immediately before a model step, correlated captures become ordinary persisted
user-role context after the corresponding user message. Values are rendered as JSON
reference data, explicitly not instructions. Historical context remains in normal
DSH conversation history after sending, even when the current editor state is cleared.

Useful business errors: `invalid`, `workspace-mismatch`, `busy`, `disconnected`,
`capacity`, `selection-too-large`, `conflict`, `closed`, `internal`, all prefixed
with `editor-socket/`. v2's `session-unavailable` is gone: v3 `connect` never
targets a session, and composer calls on a vanished session simply report an
empty state.
