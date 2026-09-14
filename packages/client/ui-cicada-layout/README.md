---
description: "Cicada root frame for the Web GUI: re-declares the four native child slots and adds the pipeline and canvas surfaces; for users and maintainers of the Cicada schematic experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cicada-layout

English | [中文](README.zh.md)

## Summary

This package replaces the native root frame in the Cicada profile's Web GUI: it re-declares the four native child slots (`sidebar`, `conversation`, `details`, `shell.overlay`) with the same kind/scope so the native occupants keep rendering, and adds two Cicada surfaces — `cicada.pipeline` (the fixed pipeline sidebar) and `cicada.canvas` (the canvas mirror). It also provides the `ctx.layout` panel-action face (toggle sidebar, open/close details) under the same contract the native layout exposed, so existing consumers (`ui-sidebar`, `ui-chat`) keep working unchanged, and projects the active theme onto `document.body`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the Cicada profile's bundle alongside `ui-cicada-pipeline` and `ui-cicada-canvas`, with the native `ui-layout` row disabled. The frame then renders four columns: sidebar, conversation, pipeline (fixed width), details; the canvas mirror floats over the details column and the overlay layer keeps the native floating surfaces.

### Registration

- `tsconfig.client.json`: one `references` entry.
- `packages/bundle/cicada-app/cordis.patch.yml`: a `dsh.client` row with id `cicada-layout` (and the `ui-layout` row overridden with `disabled: true`).
- `packages/bundle/cicada-app/package.json`: a `dependencies` entry.

### Failures

If the four native child slots are not re-declared with the exact kind/scope, the native occupants (or their declared sub-slots) disappear on entry removal. If `ctx.layout` is not provided, `ui-sidebar` and `ui-chat` stay pending on their injected service.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin contributes `CicadaAppFrame` into the built-in `root` slot. One `register()` call declares the six child slots (four native re-declarations plus the two Cicada additions) and seats the layout store; the registration's inject hook wires the store's bound actions into `CicadaLayoutController`, which the plugin provides as `ctx.layout`. A second effect registers the `cicada.layout` locale namespace; a third seats the theme presenter, which projects `ctx.theme` snapshots onto `document.body` and retracts exactly what it wrote on disposal. The pipeline column keeps a fixed contract width (`PIPELINE_DEFAULT`); sidebar and details follow the layout store's width preferences (0 = closed).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Slots reference](../../docs/subsystems/slots.md)
- [Web Client architecture](../../docs/subsystems/web-client.md)

-----

<a id="model-experience"></a>
## Model Experience

The root frame itself is not model-visible. It changes only where the model's output appears: the pipeline sidebar renders tool-call cards derived from the session event window (see `ui-cicada-pipeline`), and the canvas mirror renders the selection surface (see `ui-cicada-canvas`). Token and KV-cache effects are unchanged from the native frame.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Drag-to-resize handles for the sidebar/details columns are not implemented in v1; the store contract supports width writes, so a later iteration can add handles without changing the service face.
- The narrow-viewport auto-collapse breakpoint of the native layout is not ported; the cicada frame keeps the sidebar at its preference.

-----

<a id="dev-note"></a>
## Dev Note

The package is a dynamic client plugin: all `@deepseek-ai/dsh-*` relationships are peer + dev (never `dependencies`); the bundle declares the runtime dependency. `ctx.layout`'s type is deliberately not re-declared — the native `ui-layout` package already merges it, and this package depends on it type-only.
