# dsh-editor-claude-adapter

VS Code 扩展：把 **Claude Code** 的 IDE 选区转发进 `dsh-editor-socket`，让 DSH Web 输入区始终显示你当前的文件/选区。即便没有安装完整的 `vsc-agents-connector`，Claude 侧的编辑器上下文也不会丢。

## 前置条件

- 已安装并在 VS Code 中运行 Claude Code 扩展（它会在 `~/.claude/ide/*.lock` 暴露一个本地 WS 服务）。
- 有一个正在运行的 `dsh web`（或 `dsh --profile <name>`）实例，且加载了 `dsh-editor-socket` 插件。
- 打开的 VS Code 工作区目录 == DSH 会话的工作目录（连接以目录为单位，多根工作区只桥接第一个目录）。

## 工作方式

1. **发现**：读取 Claude IDE 锁文件挑选匹配当前工作区的连接，同时用 `discoverSockets()` 找 dsh-editor-socket 的注册文件；任一侧缺失都按 1s→2s→…→30s 退避重试。
2. **WS 连接**：向 Claude 的 `ws://127.0.0.1:<port>` 完成 `initialize` 握手，随后持续接收 `selection_changed` 通知。
3. **转发**：把通知转换成 `EditorSnapshot`（1-based 行、0-based 列；空光标只发文件路径；超 30KB 的文本丢弃但保留行号）后通过 `EditorPlug.update()` 推给 DSH。DSH 断线时保留最近一次选区并在冷却后重放。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh-claude-adapter.autoConnect` | `true` | 启动时自动发现并桥接；关闭后可用命令手动连接。 |

命令：`DSH: Connect Claude Selections`（重新发现并连接）、`DSH: Disconnect Claude Selections`（断开并停止重试）。

## 与 vsc-agents-connector 的关系

互补而非替代：`vsc-agents-connector` 负责 DSH ↔ 编辑器的聊天 UI 与多 agent 会话连接；本扩展只做一件事——把 Claude Code 的选区单向喂给 DSH 输入区。两者连接同一目录时会争用同一个 workspace 租约（后连接者收到 `busy` 并持续重试），只保留一个即可。

## 日志

所有输出以 `[dsh-claude-adapter]` 前缀写入扩展宿主日志（`Help → Toggle Developer Tools`）。只记录路径、行号与状态迁移，**不记录选区文本**。

## 开发

```sh
cd packages/claude-adapter && npm run check   # 类型检查
```

`src/claude.ts` 是不含 VS Code 依赖的纯 Node 传输层，可直接单测；`src/extension.ts` 需要 VS Code 扩展测试宿主（`@vscode/test-electron`）。

- TODO：为 `extension.ts` 补集成测试（目前仅人工联调 + 本地 mock 回归：发现重试、空选区、非法路径恢复、socket 断开重连、dsh 重启后 watchdog 重连）。
- 状态栏、树视图、更多命令均为有意不做——本扩展只是选区桥。
