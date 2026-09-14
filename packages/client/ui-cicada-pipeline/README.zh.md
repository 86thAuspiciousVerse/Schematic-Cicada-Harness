---
description: "Web GUI 的 Cicada 管线侧边栏：从会话事件窗口推导的工具调用卡片流；供 Cicada 原理图体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cicada-pipeline

[English](README.md) | 中文

## 概述

本包渲染 Cicada 管线侧边栏：当前会话工具调用的卡片流（状态 running / ok / error），完全从会话事件窗口（`SessionBinding.eventSource`）推导。它向 `ui-cicada-layout` 声明的 `cicada.pipeline` 槽注册一个条目。不新增任何 remote 事件 —— 管线是对话已在接收的事件的本地客户端投影。

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

在 Cicada profile 的 bundle 中与 `ui-cicada-layout` 一起挂载本插件。侧边栏随即作为帧的固定管线列出现，显示当前会话最近 20 次工具调用（新者居后），每次调用带状态胶囊。

### 失败

若未挂载 `ui-cicada-layout`（或它未声明 `cicada.pipeline`），`slots.inject` 注册会等待该声明，表面渲染为空。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

apply 层 effect 跟随会话列表（`ctx.sessions.list`），绑定当前会话的 `eventSource`，把每次窗口变化折叠为管线卡片（`deriveCards`：`tool/call` 条目创建卡片，匹配的 `tool/result` 条目置 ok/error）。store 写面从条目的 inject 钩子捕获（框架把 per-session store 实例的绑定动作传入）；pending 缓冲桥接首次渲染前到达的事件。卡片列表组件经 `useStore` 读 store、经 `t` 渲染文案；它从不订阅 —— 组件不拥有订阅机制（packages/client/AGENTS.md layering）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Conversation reference](../../docs/subsystems/conversation.md)
- [Slots reference](../../docs/subsystems/slots.md)

-----

<a id="model-experience"></a>
## 模型体验

管线侧边栏是纯客户端投影：它从会话日志已有的工具 call/result 事件推导，不新增任何面向模型的输入。token 与 KV-cache 影响为零。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- v1 渲染通用工具调用卡片；Cicada 三阶段管线语义（knowledge / datasheet / produce + 修复轮次）尚未映射到卡片上 —— 显示原始工具名。
- 卡片上限 20；更早的活动被丢弃，无分页。
- follow journal 视图（按轮分组、阶段着色）延期。

-----

<a id="dev-note"></a>
## 开发备注

本包是 dynamic client 插件：所有 `@deepseek-ai/dsh-*` 关系均为 peer + dev。`cicada.pipeline` 槽的类型声明位于 `ui-cicada-layout`；本包仅 type-only 导入。
