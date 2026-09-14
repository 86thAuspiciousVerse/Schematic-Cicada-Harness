# packages/cicada — Schematic-Cicada 领域包组

Schematic-Cicada 的领域能力组：PCB 原理图格式、语义推导、符号生成（P1 已成）；工具运行时、编辑器桥、launcher 等后续阶段加入。设计见 `9-impl`，施工事实见 `docs/06-施工日志/10-施工日志.md`——本组每个包的目的、边界与已知限制在各自 README。

| 包 | 服务键 | 职责 |
|---|---|---|
| [`cicada-format`](cicada-format/README.md) | `cicadaFormat` | `.cicada_sch` 词法/解析（白名单 fail-closed）/规范序列化/结构校验；坐标 G 常量单一权威 |
| [`cicada-deriver`](cicada-deriver/README.md) | `cicadaDeriver` | 语义推导：transform 唯一权威、连接图（整数精确相等）、NETn 字典序、坐标无关语义模型 |
| [`cicada-symbols`](cicada-symbols/README.md) | `cicadaSymbols` | 符号生成：IC 四边均分、模板、引脚全集守卫、全局符号缓存（root 注入） |
| [`cicada-runtime`](cicada-runtime/README.md) | `cicadaRuntime` | 运行时（P3）：8 个 producer 写工具、事务/CAS/oplog/changelog、作用域注入、错误码单一权威（21 个） |
| [`cicada-knowledge`](cicada-knowledge/README.md) | `cicadaKnowledge` | datasheet 知识（P3）：全局数据库（锚定审计 upsert）、工作区参考副本、引脚全集源、main/producer datasheet 工具 |
| [`cicada-mineru`](cicada-mineru/README.md) | `cicadaMineru` | MinerU TS 化（P3，E19 废除 Python 侧车）：submit/poll/extract（fetch + fflate；token=settings→env） |
| [`cicada-erc`](cicada-erc/README.md) | `cicadaErc` | v1 自研校验警告（P3，M2 接 ERC 引擎占位）：图结构规则 → `.cicada/warnings.json`，仅提示不阻塞 |
| [`cicada-launcher`](cicada-launcher/README.md) | `cicadaLauncher` | 单实例 launcher（P5）：锁/ping/spawnHost/stdout 行协议/dev CLI bin |
| [`cicada-editor-bridge`](cicada-editor-bridge/README.md) | — | 编辑器控制面（P6，G6）：`/cicada/editor` 命名路由（selection 注入 + state 快照）、WS 下推（hello/ping/selection.confirm）、一次性 Bearer token（stdout 交出）、selection 事件 Remote 白名单 |

约定见 `AGENTS.md`（铁律/已知量化限制）。测试：`pnpm vitest run packages/cicada`；关口：根 `pnpm verify:cicada`（G0/G1；G2-G7 后续填充）。
