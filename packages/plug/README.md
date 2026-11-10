# dsh-editor-plug

`dsh-editor-socket` 的**编辑器侧 SDK**。它只依赖 `dsh-editor-protocol`，不导入 DSH 运行时、不依赖 VS Code API，因此可以被任意编辑器扩展直接使用。

## 职责

| 模块 | 内容 |
|---|---|
| `dsh-editor-plug` | `EditorPlug`：连接、心跳、序列化 update/clear/disconnect 的客户端 |
| `dsh-editor-plug/plug` | 同上，按文件路径导入 |
| `dsh-editor-plug/discovery` | `discoverSockets()`、`defaultDiscoveryDirectory()`、`Registration` |

## 使用

```ts
import { discoverSockets } from 'dsh-editor-plug/discovery'
import { EditorPlug } from 'dsh-editor-plug'

for (const socket of await discoverSockets()) {
  const plug = new EditorPlug({
    url: socket.url,
    headers: { authorization: `Bearer ${socket.token}` },
  })
  const sessions = await plug.sessions()
  if (!sessions.some(item => item.directory === '/your/workspace')) continue

  await plug.connect({
    clientId: crypto.randomUUID(), editor: 'VS Code', workspace: '/your/workspace',
  })
  await plug.update({
    workspace: '/your/workspace', path: '/your/workspace/src/main.ts',
    selection: { start: 10, end: 15, text: 'selected buffer text' },
  })
  await plug.disconnect()
  break
}
```

`discoverSockets()` 会校验注册文件的属主、权限、大小、符号链接与回环地址；注册文件可能由异常退出的进程留下，调用方应捕获连接失败并跳过。`clientId` 在同一编辑器窗口的重连期间应保持稳定。

## 依赖约定

`dsh-editor-plug` → `dsh-editor-protocol`。本包不依赖宿主包 `dsh-editor-socket`，也不导入任何 `@deepseek-ai/*` 运行时。

协议语义见 [`docs/protocol.md`](../../docs/protocol.md)。
