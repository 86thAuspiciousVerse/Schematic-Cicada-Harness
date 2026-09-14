---
description: "Cicada pipeline sidebar for the Web GUI: a card flow of tool calls derived from the session event window; for users and maintainers of the Cicada schematic experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cicada-pipeline

English | [中文](README.zh.md)

## Summary

This package renders the Cicada pipeline sidebar: a card flow of the current session's tool calls (status running / ok / error), derived entirely from the session event window (`SessionBinding.eventSource`). It registers one entry into the `cicada.pipeline` slot declared by `ui-cicada-layout`. No new remote events are added — the pipeline is a local client projection of events the conversation already receives.

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

Mount this plugin alongside `ui-cicada-layout` in the Cicada profile's bundle. The sidebar then appears as the fixed pipeline column of the frame and shows the last 20 tool calls of the current session, newest last, each with a status pill.

### Failures

If `ui-cicada-layout` is not mounted (or does not declare `cicada.pipeline`), the `slots.inject` registration waits for the declaration and the surface renders nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

An apply-layer effect follows the sessions list (`ctx.sessions.list`), binds the current session's `eventSource`, and folds each window change into pipeline cards (`deriveCards`: `tool/call` entries create a card, matching `tool/result` entries set ok/error). The store write face is captured from the entry's inject hook (the framework passes the bound actions of the per-session store instance); a pending buffer bridges events arriving before the first render. The card list component reads the store through `useStore` and renders copy through `t`; it never subscribes — components own no subscription machinery (packages/client/AGENTS.md layering).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Conversation reference](../../docs/subsystems/conversation.md)
- [Slots reference](../../docs/subsystems/slots.md)

-----

<a id="model-experience"></a>
## Model Experience

The pipeline sidebar is a client-only projection: it derives from tool call/result events already in the session log and adds no model-visible input. Token and KV-cache effects are nil.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- v1 renders generic tool-call cards; the three-stage Cicada pipeline semantics (knowledge / datasheet / produce + repair rounds) are not yet mapped onto the cards — the raw tool names are shown.
- Cards are capped at 20; older activity is dropped without pagination.
- The follow-journal view (per-turn grouping, stage coloring) is deferred.

-----

<a id="dev-note"></a>
## Dev Note

The package is a dynamic client plugin: all `@deepseek-ai/dsh-*` relationships are peer + dev. The `cicada.pipeline` slot's type declaration lives in `ui-cicada-layout`; this package imports it type-only.
