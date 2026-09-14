# cicada-editor-bridge — 编辑器控制面

**目的**：DSH 宿主侧的编辑器控制面（P6，G6）——wx 原生壳（M2）通过命名路由 + WebSocket 与主 agent 会话交互的**唯一对齐点**（契约先行，`src/contract.ts` 冻结）。

**职责**（9-impl §1.8 / P6 定案补注）：

- **HTTP 命名路由**（`webServer.register({kind:'prefix', path:'/cicada/editor'})`，不碰 fallback）：
  - `POST /cicada/editor/selection` — 画布选中 → schema 校验 → 语言化摘要 → `Agent.followup(createUserMessage(...))` 注入主 agent 会话（wake driver）→ 发 `cicada/editor/selection` Remote 事件 → WS `selection.confirm` 回执；
  - `GET /cicada/editor/state` — 端口/文件/会话/baselineHash（`.cicada_sch` sha256，E13-D2）/警告；
  - `GET /cicada/editor/ws`（非 upgrade）→ 426；其余 → 404/405。
  - 两段鉴权（**403 → 401 顺序**）：Host/Origin 信任栅栏（`isTrustedApiRequest`，loopback 默认信任）+ 一次性 Bearer token。
- **WS 下推**（`webServer.registerUpgrade`，exact-only）：101 前完成两段鉴权（拒绝 = 手工 HTTP 响应）；v1 发射 `hello`/`ping`/`selection.confirm`，其余 4 帧类型仅声明（P7/M2）；**v1 无上行帧**（任何 uplink 帧 close 1008）。
- **token**：进程生命周期单 token（`randomBytes(32)` → base64url），Loader settle 后打印 `cicada-editor: <port> <token>` 一次；轮换 = 重打印（launcher StdoutParser 覆盖语义）；不落 config/日志。
- **Remote 白名单**：`cicada/editor/selection`（mode emit）进 `api/remotes/src/remote-events.ts`，双侧 `import type` 闭环（satisfies 断言）。

**边界**：

- 注入目标会话解析：请求体 `sessionId` → Config `mainSessionId` → `ctx.agents.roots()[0]`；无 live agent → `500 {error:'no main agent session'}`（`agent-loop agents:[]` 会话按需创建——G6 动态判据须先开 webui 建会话）。
- 附加块 v1 = 确定性中文摘要 + 原始 selection JSON（M3 前与 deriver 网络局部展开联动）。
- 只做 DSH 侧；wx C++ 客户端（EditorHttpClient/EditorWsClient）为 M2 目标。

**P7 已接线**：runtime 提交/工作区 watcher 事件会下发 `canvas.refresh`、`changelog`、`baseline`；`datasheet.update` 仍留 M2。`baselineHash` 使用文件内容 SHA-256，`FsVersion` 仅用于 runtime CAS。C++ 冒烟壳仍留 M2。
