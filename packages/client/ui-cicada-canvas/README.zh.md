---
description: "Web GUI 的 Cicada 画布镜像：为 P6 编辑器桥将发射的选中状态准备的占位表面；供 Cicada 原理图体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cicada-canvas

[English](README.md) | 中文

## 概述

本包渲染 Cicada 画布镜像：原生编辑器选中状态将被镜像到的表面。v1 为占位（P6 编辑器桥尚未交付）；表面渲染一行文案并预留 `cicada.canvas` 槽。

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

在 Cicada profile 的 bundle 中与 `ui-cicada-layout` 一起挂载本插件。镜像随即浮于帧的细节列之上，渲染占位文案。

### 失败

若未挂载 `ui-cicada-layout`（或它未声明 `cicada.canvas`），`slots.inject` 注册会等待该声明，表面渲染为空。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

本插件向 `cicada.canvas` 槽（`single`/`session`）注册一个条目，组件为 `CanvasMirror`，locale 命名空间为 `cicada.canvas`。v1 无任何订阅。P6 编辑器桥将经 remote-events 白名单（`api/remotes/src/remote-events.ts`）发射 `cicada/editor/selection`，本表面随后镜像该载荷。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Slots reference](../../docs/subsystems/slots.md)
- [Web Client architecture](../../docs/subsystems/web-client.md)

-----

<a id="model-experience"></a>
## 模型体验

v1 中画布镜像不面向模型。编辑器桥交付后，它以客户端镜像显示编辑器选中态；不新增面向模型的输入，无 token 或 KV-cache 影响。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 仅占位：P6 编辑器桥（`cicada-editor-bridge`）必须先发射 `cicada/editor/selection`，镜像才有内容可显示。
- remote-events 白名单条目（`{event:'cicada/editor/selection', mode:'emit'}`）随桥一起延期到 P6。

-----

<a id="dev-note"></a>
## 开发备注

本包是 dynamic client 插件：所有 `@deepseek-ai/dsh-*` 关系均为 peer + dev。`cicada.canvas` 槽的类型声明位于 `ui-cicada-layout`；本包仅 type-only 导入。
