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

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
