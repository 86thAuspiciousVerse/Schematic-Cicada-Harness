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

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
