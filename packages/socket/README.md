# dsh-editor-socket (host)

DSH **宿主端**。它注册原生 HTTP / Desktop IPC 路由、持有目录级编辑器租约、把已提交的编辑器快照写进会话日志，并在下一次模型调用前注入上下文。

## 职责

| 文件 | 内容 |
|---|---|
| `src/index.ts` | 插件入口：路由注册、消息捕获、`agent/pre-step` 注入 |
| `src/store.ts` | 目录级租约与实时引用（`EditorStore`） |
| `src/sessions.ts` | 只读会话发现（`EditorSessions`） |
| `src/captures.ts` | 待处理消息的上下文投影 |
| `src/transport.ts` | 仅绑定 `127.0.0.1` 的编辑者接口与 RPC 信封 |
| `src/config.ts` | `ProtocolLimits` 默认值与校验 |
| `src/client/` | DSH 浏览器端的输入区标签（esbuild 打成闭包模块） |

子路径导出：`.`、`./store`、`./sessions`、`./captures`、`./transport`、`./config`、`./client`。

## 依赖约定

依赖 `dsh-editor-protocol` 与 `dsh-editor-plug`；`@deepseek-ai/*` 一律是 peer 依赖，由 DSH 宿主提供，本包不打包它们。`zod` 用于 `captures.ts` 的投影状态校验。

宿主自身的 ESM 产物由 `tsc` 生成；只有 `src/client/` 需要 `build.mjs` 的 esbuild 闭包打包，因为 DSH 动态客户端模块不是浏览器 ESM import。

安装与配置见[仓库根目录 README](../../README.md)，协议细节见 [`docs/protocol.md`](../../docs/protocol.md)。
