# dsh-editor-socket

让 DeepSeek Harness（dsh）的现有输入区接收编辑器当前文件和选区。点击或划选只同步上下文；用户在 dsh 发送消息时，上下文才随消息进入 agent。

`dsh-editor-socket` 是 dsh 侧的 **socket**；VS Code 的 `vsc-agents-connector` DSH adapter 是 **plug**。一个 VS Code 扩展可以同时提供 OpenCode、DSH 等多个 agent 的连接入口，每次连接一个工作目录。

## 功能

- **连接单位是工作目录（cwd），不是会话。** 编辑器对某个目录连接一次，该目录下的全部 dsh 会话——已打开的、历史未加载的、以及连接之后新建的——共享同一份跟随上下文；在该目录任一会话里发消息，都会冻结当时的编辑器引用。
- 连接与发现都不激活会话。历史会话在用户于 dsh 界面打开时才恢复；编辑器连接目录、列出会话均为只读操作，不会启动任何模型任务。
- 跟随当前文件和选区，在输入框内显示紧凑的文件名与行号标签，悬停查看完整路径；可附带未保存的选中文本。
- 标签只提供 × 清除按钮；清除后不附带上下文，切换文件或选区后恢复跟随。
- 发送时冻结上下文。排队期间继续切换文件，不会改写已提交消息的引用。
- 目录级单编辑器租约、递增序号；断线约 30 秒后清理跟随引用。同目录的会话生灭不影响租约。
- 已提交的快照进入 dsh 会话日志，支持插件重载后的待处理消息恢复。实时跟随只保存在内存中。
- dsh 输入区使用原有 HTTP / Desktop IPC 通道；编辑器使用仅绑定 `127.0.0.1` 的独立接口。
- 会话发现返回 dsh 的当前标题（含用户重命名），没有标题时由编辑器回退显示会话 ID；Web / Desktop 发现包含尚未加载的历史会话。

目前验证的版本为 **dsh 0.2.2-rc.1、Node.js 26.4.0**。包要求 Node.js ≥24.9.0，并锁定该 dsh 版本；升级 dsh 后需要重新验证其插件 API。

0.3.0 使用协议 v3，连接与状态的键从会话改为工作目录，`connect` 不再恢复会话；VS Code 请配套使用 `vsc-agents-connector 0.4.0+`。旧协议注册不会被新 SDK 发现，升级两端后重新连接。

## 仓库结构

本仓库是 npm workspaces monorepo，按「协议契约 → 编辑器 SDK → 宿主」三层拆分：

```
dsh-editor-socket/
├── package.json            # 根包（private），workspaces: ["packages/*"]
├── tsconfig.base.json      # 共享 compilerOptions
├── packages/
│   ├── protocol/           # dsh-editor-protocol  3.0.0
│   ├── plug/               # dsh-editor-plug      3.0.0
│   └── socket/             # dsh-editor-socket    0.3.0
├── scripts/  test/  docs/  locale/
└── cordis.patch.yml
```

| 包 | 版本 | 职责 | 内部依赖 |
|---|---|---|---|
| `dsh-editor-protocol` | 3.0.0 | 协议 schema、版本号、类型与边界校验。只依赖 `zod` | — |
| `dsh-editor-plug` | 3.0.0 | 编辑器 SDK：`EditorPlug` 客户端与本地发现 | protocol |
| `dsh-editor-socket` | 0.3.0 | DSH 宿主端：路由、租约、上下文捕获与注入 | protocol、plug |

依赖方向单一，没有循环：`socket → plug → protocol`。`protocol` 是叶子，只描述线上格式，因此协议版本号（`PROTOCOL_VERSION = 3`）独立于两个包的发布版本。

**版本策略**：`protocol` 与 `plug` 同为主版本号 3，对应协议 v3，两者必须一起升级——编辑器和 SDK 之间没有向后兼容承诺。宿主包 `dsh-editor-socket` 保留 0.3.0 的既有版本序列，便于已安装它的 dsh profile 平滑升级。协议不兼容时，发现与 `connect` 都会各自校验版本并拒绝旧对端。

### 构建与检查

每个包独立用 `tsc` 构建（不使用 project references，也不用 esbuild 统一打包）；宿主端只有浏览器侧 `client/` 由 esbuild 打成 DSH 闭包模块。

```sh
npm install     # 解析 workspaces，把三个包互相链接到 node_modules
npm run check   # 三个包分别 tsc --noEmit，外加根目录测试类型检查
npm run build   # 按 protocol → plug → socket 顺序构建
npm test        # 12 个测试，直接以包名 import 源码
```

`npm run build` 与 `npm run check` 都按依赖顺序执行，因此不会出现「socket 先于 protocol 构建」的问题。测试通过 `development` export 条件直接解析到各包 `src/*.ts`，所以 `npm test` 无需先构建。

### 本地开发与发布

根包保持 `name: dsh-editor-socket`，`main`/`types`/`exports` 指向 `packages/socket/lib/`，因此 `dsh plugin add /path/to/dsh-editor-socket` 与 `cordis.patch.yml` 的行为与单包时期一致。`npm pack` 生成的 tarball 包含 `packages/*/lib`、`locale`、`cordis.patch.yml`、README 与协议文档。

注意 tarball 的依赖边界：根包的 `dependencies` 指向 `dsh-editor-protocol` 与 `dsh-editor-plug`，而这两个包目前尚未发布到 npm（见下文），所以从 tarball 安装会去 registry 解析它们并失败。需要 tarball 分发时，请先发布这两个包，或改用目录安装（`dsh plugin add /path/to/dsh-editor-socket`），后者通过符号链接整个 checkout，可直接使用工作区内的三个包。

## 安装

此仓库尚未发布到 npm。先构建本地 checkout，再添加到正在使用的 dsh profile：

```sh
cd dsh-editor-socket
npm install
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-editor-socket
```

重启对应 dsh profile。Desktop 用户应使用 Desktop 安装附带的 `dsh` 命令管理已初始化的 `desktop` profile；npm 安装的 CLI 不管理 Desktop profile。

也可用 `npm pack` 生成 tarball，再用 `dsh plugin --profile web add /absolute/path/to/dsh-editor-socket-0.3.0.tgz` 安装，但前提是 `dsh-editor-protocol` 与 `dsh-editor-plug` 已发布到 npm；当前这两个包未发布，标准做法仍是上面的目录安装。`prepack` 会运行类型检查、测试和构建。安装本插件后，还需要编辑器侧 plug 才会收到点击和选区事件。

## 编辑器接入

库提供无 DSH / VS Code 运行时依赖的发现与通信模块：

```ts
import { discoverSockets } from 'dsh-editor-plug/discovery'
import { EditorPlug } from 'dsh-editor-plug'

for (const socket of await discoverSockets()) {
  const plug = new EditorPlug({
    url: socket.url,
    headers: { authorization: `Bearer ${socket.token}` },
  })
  // 注册文件可能由异常退出的进程留下；实际集成应捕获连接失败并跳过。
  const sessions = await plug.sessions()
  // 用会话列表判断该实例是否服务目标工作目录；连接本身只认目录，不挑会话。
  const serves = sessions.some(item => item.directory === '/your/workspace')
  if (!serves) continue
  await plug.connect({
    clientId: crypto.randomUUID(), editor: 'VS Code', workspace: '/your/workspace',
  })
  await plug.update({
    workspace: '/your/workspace', path: '/your/workspace/src/main.ts',
    selection: { start: 10, end: 15, text: 'selected buffer text' },
  })
  // plug.clear() 清除当前引用；后续 update() 恢复跟随。
  // 关闭编辑器连接时调用：
  await plug.disconnect()
  break
}
```

编辑器负责对点击和选区事件去抖，并在离开当前工作区或没有文件时调用 `clear()`。行号从 1 开始，结束行包含在范围内；若 VS Code 选区结束于下一行第 0 列，结束行应回退一行。未选择文本时只发送文件路径。`clientId` 在同一编辑器窗口的重连期间应保持稳定。

`sessions()` 仅供编辑器挑选/展示目标目录（复用 dsh 的原生 Session 列表，包含未加载历史、跳过 subagent 子会话、已归档会话和未加载的空白占位会话）。连接、更新、清除都只以 `workspace` 为键；同目录会话随后被用户打开时自动纳入覆盖。目录在连接时必须存在于 dsh 宿主文件系统，否则返回 `workspace-mismatch`。编辑器与 dsh 必须处于同一文件系统命名空间；Remote SSH / 容器场景应让 VS Code workspace 扩展和 dsh 在同一远端运行。当前不提供跨机器路径映射或远程监听。

## 配置与协议

默认发现目录：`${XDG_STATE_HOME:-~/.local/state}/dsh-editor-socket`。每个运行实例写入一个独立、权限为 `0600` 的注册文件，包含回环地址和本次启动的随机令牌。令牌只用于 editor socket 操作，不是 dsh 模型密钥。不要把注册文件或令牌提交到 Git。

可在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: dsh-editor-socket
  config:
    maxSelectionBytes: 32768
    maxWorkspaces: 32
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

链接脚本只在本仓库创建被 Git 忽略的 `node_modules` 链接，不修改 dsh checkout；它把依赖装在**根** `node_modules`，三个工作区包通过 Node 的目录向上查找共享同一份 `@deepseek-ai/*`，无需在 `packages/*` 下重复安装。常规独立开发使用 `npm install`；注意 `npm install` 会按 `package.json` 重新解析依赖，可能替掉上述本地链接，离线环境请先准备 registry 缓存或改用 `link:dsh`。

测试包含真实 dsh AgentLoop / Connection 服务、录制型模型适配器、本机 HTTP listener、同目录多会话共享上下文、队列快照与插件重载恢复，以及输入区渲染和订阅取消。测试不访问模型 API、不修改已有 dsh profile；运行环境需要允许本机回环监听。Desktop 覆盖的是原生 IPC 共用的 Fetch 路由，不等同于 Electron 界面的人工验收。

本仓库已作为 `vsc-agents-connector` 的 `vendor/dsh-editor-socket` submodule 接入。安装连接器 VSIX 后，使用 **VSC Agents: Connect to Local Service** 选择目标目录下的任意 DSH 会话即可开始跟随；连接以目录为单位，同目录其余会话自动纳入。

> **升级注意**：本仓库改为 monorepo 后，构建产物不再是扁平的 `lib/plug.js`、`lib/discovery.js`、`lib/protocol.js`，而是 `packages/plug/lib/*.js`、`packages/protocol/lib/index.js`。`vsc-agents-connector` 里 `src/agents/dsh/index.ts` 与 `tsconfig.dsh.json` 对 vendor 路径的引用需要同步改为新位置（或改为按包名 `dsh-editor-plug` / `dsh-editor-protocol` 导入并在 connector 侧配置 workspace 依赖）。

两个仓库都构建后，可以验证编译后的 VS Code adapter 与真实 DSH AgentLoop 的完整通信链路：

```sh
node scripts/smoke-vscode.mjs ../vsc-agents-connector/out/src/agents/dsh/index.js
```

历史会话回归使用真实 DSH 进程重启、磁盘持久化与编译后的 VS Code adapter，验证「6 条历史全部列出、发现和连接各加载 0 条、用户打开的会话被目录租约覆盖、发送后捕获编辑器上下文」：

```sh
# 需要 PATH 中的 dsh，并先编译 ../vsc-agents-connector；所有数据位于独立临时目录。
npm run test:history
# 也可指定其他已编译的 adapter：
node scripts/smoke-history.mjs /path/to/connector/out/src/agents/dsh/index.js
```

脚本只启停它创建的测试进程，不改动日常 profile；成功时清理临时目录，失败时保留诊断文件。

真实 VS Code + Chrome 的启动脚本、操作步骤、录制验证和本次界面问题的修复记录见 [GUI 验收文档](https://github.com/YMoose/dsh-editor-socket/blob/main/docs/testing/gui.md)（源码路径 `docs/testing/gui.md`）。测试工具和截图只保留在源码仓库，不加入插件运行包。

标题 GUI 回归使用 `prepare.mjs --titles` 和 `check-title.mjs`，覆盖选择器、状态栏、完整悬停提示、网页重命名后重连、窗口重载恢复以及无标题回退；具体命令见上述文档的「会话标题回归」。
