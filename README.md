# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## This snapshot: Schematic-Cicada additions

This repository is a snapshot of DeepSeek Harness as used by
[Schematic-Cicada](https://github.com/86thAuspiciousVerse/Schematic-Cicada) — a
Windows desktop EDA assistant whose canvas is driven by an AI pipeline. The
engine and the Electron launcher live in that companion repository; everything
the pipeline runs on lives here:

| Path | What it adds |
|---|---|
| `packages/cicada/cicada-format` | schematic file model: parse/serialise `.cicada_sch`, the KiCad dialect whitelist |
| `packages/cicada/cicada-deriver` | semantic view: nets, refdes naming, placement transforms |
| `packages/cicada/cicada-symbols` | symbol geometry and datasheet-to-shape mapping |
| `packages/cicada/cicada-runtime` | the eight schematic write tools, placement and routing, role scoping, ledger |
| `packages/cicada/cicada-knowledge` | datasheet library, anchor audit, knowledge-landscape contract, workspace readers |
| `packages/cicada/cicada-mineru` | MinerU extraction client (datasheet PDF to markdown) |
| `packages/cicada/cicada-launcher` | host launcher: engine supervision, model route, optional search overlay |
| `packages/preset/agent-presets/presets/cicada` | the product preset: orchestrator script and the knowledge / datasheet / producer role personas |
| `packages/bundle/cicada-app` | the bundle that wires the product host, its providers and client roster |

Development-only state (compiled artefacts under `src/`, the local live-provider
home, machine-specific configuration) is intentionally not part of this snapshot.
Credentials are never stored here: the launcher reads them from the environment
or from gitignored local files.


