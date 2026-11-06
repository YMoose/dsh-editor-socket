# dsh-editor-socket

让 DeepSeek Harness（dsh）的现有输入区接收编辑器当前文件、选区和固定引用。点击或划选只同步上下文；用户在 dsh 发送消息时，上下文才随消息进入 agent。

`dsh-editor-socket` 是 dsh 侧的 **socket**；VS Code 的 `vsc-agents-connector` DSH adapter 是 **plug**。一个 VS Code 扩展可以同时提供 OpenCode、DSH 等多个 agent 的连接入口，每次连接一个会话。

## 功能

- 跟随当前文件和选区，显示相对路径与行号；可附带未保存的选中文本。
- 固定、清除、移除引用；固定引用随下一条用户消息发送一次，当前跟随引用持续有效。
- 发送时冻结上下文。排队期间继续切换文件，不会改写已提交消息的引用。
- 会话隔离、单编辑器租约、递增序号；断线约 30 秒后清理跟随引用。固定引用保留到发送或手动清除。
- 已提交的快照进入 dsh 会话日志，支持插件重载后的待处理消息恢复。实时跟随和未提交的固定引用只保存在内存中。
- dsh 输入区使用原有 HTTP / Desktop IPC 通道；编辑器使用仅绑定 `127.0.0.1` 的独立接口。
- 会话发现返回 dsh 的当前标题（含用户重命名），没有标题时由编辑器回退显示会话 ID。
- Web / Desktop 会话发现包含尚未加载的历史会话；选中时通过 dsh 的原生接口恢复该会话，展开列表不会批量启动 agent。

目前验证的版本为 **dsh 0.2.2-rc.1、Node.js 26.4.0**。包要求 Node.js ≥24.9.0，并锁定该 dsh 版本；升级 dsh 后需要重新验证其插件 API。

## 安装

此仓库尚未发布到 npm。先构建本地 checkout，再添加到正在使用的 dsh profile：

```sh
cd dsh-editor-socket
npm install
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-editor-socket
```

重启对应 dsh profile。Desktop 用户应使用 Desktop 安装附带的 `dsh` 命令管理已初始化的 `desktop` profile；npm 安装的 CLI 不管理 Desktop profile。

也可用 `npm pack` 构建并生成 tarball，再用 `dsh plugin --profile web add /absolute/path/to/dsh-editor-socket-0.1.2.tgz` 安装。`prepack` 会运行类型检查、测试和构建。安装本插件后，还需要编辑器侧 plug 才会收到点击和选区事件。

## 编辑器接入

库提供无 DSH / VS Code 运行时依赖的发现与通信模块：

```ts
import { discoverSockets } from 'dsh-editor-socket/discovery'
import { EditorPlug } from 'dsh-editor-socket/plug'

for (const socket of await discoverSockets()) {
  const plug = new EditorPlug({
    url: socket.url,
    headers: { authorization: `Bearer ${socket.token}` },
  })
  // 注册文件可能由异常退出的进程留下；实际集成应捕获连接失败并跳过。
  const sessions = await plug.sessions()
  // 让用户选择与当前 workspace 根目录完全相同的会话（可包含未加载的历史）。
  const session = sessions.find(item => item.directory === '/your/workspace')
  if (!session) continue
  await plug.connect({
    sessionId: session.sessionId, clientId: crypto.randomUUID(),
    editor: 'VS Code', workspace: session.directory,
  })
  await plug.update({
    workspace: session.directory, path: '/your/workspace/src/main.ts',
    selection: { start: 10, end: 15, text: 'selected buffer text' },
  })
  // plug.pin() 固定当前引用；plug.clear() 清除跟随引用。
  // 关闭编辑器连接时调用：
  await plug.disconnect()
  break
}
```

编辑器负责对点击和选区事件去抖，并在离开当前工作区或没有文件时调用 `clear()`。行号从 1 开始，结束行包含在范围内；若 VS Code 选区结束于下一行第 0 列，结束行应回退一行。未选择文本时只发送文件路径。`clientId` 在同一编辑器窗口的重连期间应保持稳定。

Web / Desktop 宿主通过 `sessionController` 枚举普通会话，包括磁盘中的历史；跳过 subagent 子会话、已归档会话和未加载的空白占位会话。已加载的空白会话仍可连接，方便在第一条消息前接入编辑器。列表查询只读，连接时先检查工作目录，再按需恢复选中的 agent。未挂载该服务的精简宿主兼容原来的已加载会话模式。编辑器与 dsh 必须处于同一文件系统命名空间；Remote SSH / 容器场景应让 VS Code workspace 扩展和 dsh 在同一远端运行。当前不提供跨机器路径映射或远程监听。

## 配置与协议

默认发现目录：`${XDG_STATE_HOME:-~/.local/state}/dsh-editor-socket`。每个运行实例写入一个独立、权限为 `0600` 的注册文件，包含回环地址和本次启动的随机令牌。令牌只用于 editor socket 操作，不是 dsh 模型密钥。不要把注册文件或令牌提交到 Git。

可在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: dsh-editor-socket
  config:
    maxSelectionBytes: 32768
    maxPinned: 8
    maxSessions: 32
    leaseMs: 30000
    watchMs: 25000
    maxWatchers: 128
    # discoveryDirectory: /absolute/private/directory
```

插件不会自动读取引用文件；只有编辑器明确发送的选中文本会进入快照。超过文本大小上限的更新会被拒绝，编辑器可省略 `selection.text`，保留路径和行号。

完整请求格式、操作和错误见 [docs/protocol.md](docs/protocol.md)。

## 开发

如果本机已有安装依赖并构建过的 deepseek-harness checkout，可以离线链接其依赖：

```sh
npm run link:dsh -- /path/to/deepseek-harness
npm run check
npm test
npm run build
```

链接脚本只在本仓库创建被 Git 忽略的 `node_modules` 链接，不修改 dsh checkout。常规独立开发使用 `npm install`。

测试包含真实 dsh AgentLoop / Connection 服务、录制型模型适配器、本机 HTTP listener、队列快照与插件重载恢复，以及输入区渲染和订阅取消。测试不访问模型 API、不修改已有 dsh profile；运行环境需要允许本机回环监听。Desktop 覆盖的是原生 IPC 共用的 Fetch 路由，不等同于 Electron 界面的人工验收。

本仓库已作为 `vsc-agents-connector` 的 `vendor/dsh-editor-socket` submodule 接入。安装连接器 VSIX 后，使用 **VSC Agents: Connect to Local Service** 选择对应 DSH 会话即可开始跟随。

两个仓库都构建后，可以验证编译后的 VS Code adapter 与真实 DSH AgentLoop 的完整通信链路：

```sh
node scripts/smoke-vscode.mjs ../vsc-agents-connector/out/src/agents/dsh/index.js
```

历史会话回归使用真实 DSH 进程重启、磁盘持久化与编译后的 VS Code adapter，验证「6 条历史全部列出、查询时加载 0 条、选择后仅恢复 1 条」以及恢复后的选区捕获：

```sh
# 需要 PATH 中的 dsh，并先编译 ../vsc-agents-connector；所有数据位于独立临时目录。
npm run test:history
# 也可指定其他已编译的 adapter：
node scripts/smoke-history.mjs /path/to/connector/out/src/agents/dsh/index.js
```

脚本只启停它创建的测试进程，不改动日常 profile；成功时清理临时目录，失败时保留诊断文件。

真实 VS Code + Chrome 的启动脚本、操作步骤、录制验证和本次界面问题的修复记录见 [GUI 验收文档](https://github.com/YMoose/dsh-editor-socket/blob/main/docs/testing/gui.md)（源码路径 `docs/testing/gui.md`）。测试工具和截图只保留在源码仓库，不加入插件运行包。

标题 GUI 回归使用 `prepare.mjs --titles` 和 `check-title.mjs`，覆盖选择器、状态栏、完整悬停提示、网页重命名后重连、窗口重载恢复以及无标题回退；具体命令见上述文档的「会话标题回归」。
