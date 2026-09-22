# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 本快照：Schematic-Cicada 增补

本仓库是 [Schematic-Cicada](https://github.com/86thAuspiciousVerse/Schematic-Cicada)
（Windows 单机桌面 EDA 助手，画布由 AI 管道驱动）所使用的 DeepSeek Harness 快照。
引擎与 Electron 启动器在配套仓库，**AI 管道运行所需的一切在这里**：

| 路径 | 增补内容 |
|---|---|
| `packages/cicada/cicada-format` | 原理图文件模型：`.cicada_sch` 解析/序列化、KiCad 方言白名单 |
| `packages/cicada/cicada-deriver` | 语义视图：网络、位号命名、放置变换 |
| `packages/cicada/cicada-symbols` | 符号几何与"数据手册→形状块"映射 |
| `packages/cicada/cicada-runtime` | 八件原理图写工具、落位与绕线、角色作用域、台账 |
| `packages/cicada/cicada-knowledge` | 数据手册库、锚点审计、知识图景契约、工作区读工具 |
| `packages/cicada/cicada-mineru` | MinerU 抽取客户端（PDF → markdown） |
| `packages/cicada/cicada-launcher` | 宿主启动器：引擎监督、模型路由、可选搜索叠加 |
| `packages/preset/agent-presets/presets/cicada` | 产品 preset：主编排剧本与 knowledge / datasheet / producer 三个角色 persona |
| `packages/bundle/cicada-app` | 把产品宿主、provider 与客户端花名册装配起来的 bundle |

开发专用状态（`src/` 下的编译产物、本地 live-provider home、机器相关配置）**不在快照内**；
凭据从不入库：启动器从环境变量或 gitignore 的本地文件读取。

