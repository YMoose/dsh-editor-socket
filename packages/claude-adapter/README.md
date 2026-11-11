# dsh-editor-claude-adapter

> **⚠️ 实验性 / 已知限制**：本扩展通过 Claude Code 扩展暴露的本地 WS 服务（`~/.claude/ide/*.lock`）获取选区，但 **Claude 扩展只允许一个 WS 客户端**——它在新连接到来时会主动断开旧连接（`u.close()`）。因此：
>
> - **如果你在用 OpenCode TUI ≥ v2.2.6**，它自带的 Claude WS 客户端会和本扩展互相踢对方（每 1 秒一次），两边都拿不到稳定的选区流。**这种情况下不要用本扩展**。
> - **只有在"装了 Claude Code 扩展、但没有任何其他 IDE WS 客户端"的场景**，本扩展才能稳定工作。
>
> 绝大多数用户应该用 [`vsc-agents-connector`](https://github.com/YMoose/vsc-agents-connector)——它直接读 VS Code 的 `window.activeTextEditor.selection`，不走 Claude WS，和 OpenCode TUI 不冲突，是更通用的方案。
>
> 本包保留在 monorepo 中是因为：
>
> 1. `claude.ts` 是一个完整的 Claude Code IDE 协议客户端实现，未来如果 Anthropic 把 WS 改成多客户端，可以直接启用。
> 2. `extension.ts` 的 `EditorPlug` 连接管理（lease/heartbeat/reconnect/冷却重放）对其他传输层也有参考价值。
> 3. dsh-editor-protocol 的 `startCharacter`/`endCharacter` 字段是为这条链路加的，留一个能消费它们的实现作为参考。

---

VS Code 扩展：把 **Claude Code** 的 IDE 选区转发进 `dsh-editor-socket`，让 DSH Web 输入区始终显示你当前的文件/选区。即便没有安装完整的 `vsc-agents-connector`，Claude 侧的编辑器上下文也不会丢。

## 前置条件

- 已安装并在 VS Code 中运行 Claude Code 扩展（它会在 `~/.claude/ide/*.lock` 暴露一个本地 WS 服务）。
- **没有**其他 Claude WS 客户端在跑（最典型的是 OpenCode TUI；见上方警告）。
- 有一个正在运行的 `dsh web`（或 `dsh --profile <name>`）实例，且加载了 `dsh-editor-socket` 插件。
- 打开的 VS Code 工作区目录 == DSH 会话的工作目录（连接以目录为单位，多根工作区只桥接第一个目录）。

## 工作方式

1. **发现**：读取 Claude IDE 锁文件挑选匹配当前工作区的连接，同时用 `discoverSockets()` 找 dsh-editor-socket 的注册文件；任一侧缺失都按 1s→2s→…→30s 退避重试。
2. **WS 连接**：向 Claude 的 `ws://127.0.0.1:<port>` 完成 `initialize` 握手，随后持续接收 `selection_changed` 通知。
3. **转发**：把通知转换成 `EditorSnapshot`（1-based 行、0-based 列；空光标只发文件路径；超 30KB 的文本丢弃但保留行号）后通过 `EditorPlug.update()` 推给 DSH。DSH 断线时保留最近一次选区并在冷却后重放。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh-claude-adapter.autoConnect` | `true` | 启动时自动发现并桥接；关闭后可用命令手动连接。**如果你同时跑 OpenCode TUI，建议设为 `false`。** |

命令：`DSH: Connect Claude Selections`（重新发现并连接）、`DSH: Disconnect Claude Selections`（断开并停止重试）。

## 与 vsc-agents-connector 的关系

**vsc-agents-connector 是推荐方案**：它直接调 VS Code API 拿选区，不依赖 Claude 扩展，和 OpenCode TUI 共存无冲突。

本扩展只是一个**窄场景的备选**：你装了 Claude Code 扩展但不想装 vsc-agents-connector，且不跑 OpenCode TUI 时，可以把选区桥到 DSH。两者连接同一目录时会争用同一个 workspace 租约（后连接者收到 `busy` 并持续重试），**实际使用时二选一**。

## 日志

所有输出以 `[dsh-claude-adapter]` 前缀写入扩展宿主日志（`Help → Toggle Developer Tools`）。同步追加到 `~/.local/state/dsh-claude-adapter.log` 便于外部观察。只记录路径、行号与状态迁移，**不记录选区文本**。

## 开发

```sh
cd packages/claude-adapter && npm run check   # 类型检查
npm run build                                  # tsc + esbuild bundle → lib/extension.cjs
```

`src/claude.ts` 是不含 VS Code 依赖的纯 Node 传输层，可直接单测；`src/extension.ts` 需要 VS Code 扩展测试宿主（`@vscode/test-electron`）。

- TODO：为 `extension.ts` 补集成测试（目前仅人工联调 + 本地 mock 回归：发现重试、空选区、非法路径恢复、socket 断开重连、dsh 重启后 watchdog 重连）。
- 状态栏、树视图、更多命令均为有意不做——本扩展只是选区桥。

## 已知失败模式

连接成功握手后约 1 秒被对端以 WS close code **1005**（"no status rcvd"，`wasClean: true`）断开，并随重连进入死循环 → 说明有另一个 Claude WS 客户端（通常是 OpenCode TUI）在与本扩展互踢。**解法**：关掉另一边，或停用本扩展改用 vsc-agents-connector。
