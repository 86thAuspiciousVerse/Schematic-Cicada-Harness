---
description: "Cicada canvas mirror for the Web GUI: a placeholder surface for the selection state that the P6 editor bridge will emit; for users and maintainers of the Cicada schematic experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cicada-canvas

English | [中文](README.zh.md)

## Summary

This package renders the Cicada canvas mirror: the surface where the native editor's selection state will be mirrored. In v1 it is a placeholder (the P6 editor bridge has not shipped yet); the surface renders a single line of copy and reserves the `cicada.canvas` slot.

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

Mount this plugin alongside `ui-cicada-layout` in the Cicada profile's bundle. The mirror then floats over the details column of the frame, rendering the placeholder copy.

### Failures

If `ui-cicada-layout` is not mounted (or does not declare `cicada.canvas`), the `slots.inject` registration waits for the declaration and the surface renders nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one entry into the `cicada.canvas` slot (`single`/`session`) with the `CanvasMirror` component and the `cicada.canvas` locale namespace. There are no subscriptions in v1. The P6 editor bridge will emit `cicada/editor/selection` through the remote-events whitelist (`api/remotes/src/remote-events.ts`), and this surface will then mirror the payload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Slots reference](../../docs/subsystems/slots.md)
- [Web Client architecture](../../docs/subsystems/web-client.md)

-----

<a id="model-experience"></a>
## Model Experience

The canvas mirror is not model-visible in v1. Once the editor bridge ships, it shows the editor's selection as a client-side mirror; it adds no model-visible input and no token or KV-cache effects.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Placeholder only: the P6 editor bridge (`cicada-editor-bridge`) must emit `cicada/editor/selection` before the mirror has anything to show.
- The remote-events whitelist entry (`{event:'cicada/editor/selection', mode:'emit'}`) is deferred to P6 with the bridge.

-----

<a id="dev-note"></a>
## Dev Note

The package is a dynamic client plugin: all `@deepseek-ai/dsh-*` relationships are peer + dev. The `cicada.canvas` slot's type declaration lives in `ui-cicada-layout`; this package imports it type-only.
