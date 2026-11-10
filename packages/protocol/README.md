# dsh-editor-protocol

`dsh-editor-socket` 的**协议契约包**。这里只放编辑器与 DSH 宿主之间共享的线上格式，不含任何编辑器、VS Code 或 DSH 运行时依赖。

## 职责

- `PROTOCOL_VERSION` 与 `CHANNEL`：协议版本号与回环接口路径前缀。
- 类型定义：`EditorSnapshot`、`EditorState`、`SessionDescriptor`、`ConnectRequest`、`ConnectionReceipt`、`Mutation`、`ProtocolLimits`。
- 边界校验与归一化：`SocketError`、`record`、`string`、`integer`、`normalizePath`、`snapshotOf`。
- 模型上下文渲染：`label`、`renderContext`。

## 依赖约定

本包**只依赖 `zod`**，不依赖 `dsh-editor-plug` 或 `dsh-editor-socket`。它是依赖图的叶子：另外两个包都可以依赖它，它不能反向依赖任何内部包。

这也是为什么协议版本可以独立演进：`dsh-editor-plug` 与 `dsh-editor-socket` 在同一次发布中升级到相同的主版本号，而本包只描述它们之间的契约。

## 使用

```ts
import { PROTOCOL_VERSION, SocketError, normalizePath } from 'dsh-editor-protocol'
import type { EditorSnapshot, EditorState } from 'dsh-editor-protocol'
```

本包不直接面向用户；正常使用请安装 `dsh-editor-socket`（宿主）或 `dsh-editor-plug`（编辑器 SDK）。

协议语义与请求格式见仓库根目录的 [`docs/protocol.md`](../../docs/protocol.md)。
