---
description: "Web GUI 的 Cicada 根帧：同名重声明四个原生子槽并新增管线与画布表面；供 Cicada 原理图体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cicada-layout

[English](README.md) | 中文

## 概述

本包在 Cicada profile 的 Web GUI 中替换原生根帧：同名重声明四个原生子槽（`sidebar`、`conversation`、`details`、`shell.overlay`），kind/scope 与原生一致，使原生占据者继续照常渲染；并新增两个 Cicada 表面 —— `cicada.pipeline`（固定管线侧边栏）与 `cicada.canvas`（画布镜像）。它同时以原生布局暴露过的同一契约提供 `ctx.layout` 面板动作面（切换侧边栏、开合细节区），让既有消费者（`ui-sidebar`、`ui-chat`）无需改动继续工作，并把活动主题投影到 `document.body`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Cicada profile 的 bundle 中与 `ui-cicada-pipeline`、`ui-cicada-canvas` 一起挂载本插件，并把原生 `ui-layout` 行设为 disabled。帧随后渲染四列：sidebar、conversation、pipeline（固定宽度）、details；画布镜像浮于细节列之上，overlay 层保留原生浮动表面。

### 登记

- `tsconfig.client.json`：一条 `references` 项。
- `packages/bundle/cicada-app/cordis.patch.yml`：一条 id 为 `cicada-layout` 的 `dsh.client` 行（并把 `ui-layout` 行覆盖为 `disabled: true`）。
- `packages/bundle/cicada-app/package.json`：一条 `dependencies` 项。

### 失败

若四个原生子槽未以完全一致的 kind/scope 重声明，其占据者（或它们声明的子槽）会在入口移除时消失。若未提供 `ctx.layout`，`ui-sidebar` 与 `ui-chat` 会停留在注入服务的等待状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

本插件把 `CicadaAppFrame` 贡献进内置 `root` 槽。一次 `register()` 调用声明六个子槽（四个原生重声明 + 两个 Cicada 新增）并安放布局 store；注册的 inject 钩子把 store 的绑定动作接进 `CicadaLayoutController`，后者以 `ctx.layout` 提供服务。第二个 effect 注册 `cicada.layout` locale 命名空间；第三个安放主题投影器，把 `ctx.theme` 快照投影到 `document.body`，并在销毁时只回撤自己写入的内容。管线列保持固定契约宽度（`PIPELINE_DEFAULT`）；侧边栏与细节列跟随布局 store 的宽度偏好（0 = 关闭）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Slots reference](../../docs/subsystems/slots.md)
- [Web Client architecture](../../docs/subsystems/web-client.md)

-----

<a id="model-experience"></a>
## 模型体验

根帧本身不面向模型。它只改变模型输出的出现位置：管线侧边栏渲染从会话事件窗口推导的工具调用卡片（见 `ui-cicada-pipeline`），画布镜像渲染选中表面（见 `ui-cicada-canvas`）。token 与 KV-cache 影响与原生帧一致。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- v1 未实现侧边栏/细节列的拖拽调宽；store 契约已支持宽度写入，后续迭代可加手柄而无需改动服务面。
- 未移植原生布局的窄视口自动折叠断点；cicada 帧保持侧边栏为偏好宽度。

-----

<a id="dev-note"></a>
## 开发备注

本包是 dynamic client 插件：所有 `@deepseek-ai/dsh-*` 关系均为 peer + dev（绝不进 `dependencies`）；bundle 声明运行时依赖。`ctx.layout` 的类型刻意不重复声明 —— 原生 `ui-layout` 包已合并该声明，本包仅 type-only 依赖它。
