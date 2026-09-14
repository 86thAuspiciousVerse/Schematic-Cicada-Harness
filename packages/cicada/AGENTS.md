# AGENTS.md — packages/cicada

本文件是 **Schematic-Cicada 自己的约定**（我们在 P1 立此文件）。它与上游 deepseek-harness 的 AGENTS.md 无关：上游规范仅作"旁路指导"（机械事实），与本文件冲突时**以本文件 + 下方文档线为准**。

## 权威文档线（按序，后者覆盖前者）

1. `3-gaps`（§E1-E25 决策）→ `4-spec` / `8-spec`（契约）→ `6-plan`（P0-P7 / G0-G7）→ `7-arch`（文件树，形状不改，补漏登记）→ `9-impl`（实现层施工图）→ `docs/06-施工日志/10-施工日志.md`（施工事实与坑）。
2. 文档矛盾以 `docs/07-子代理过程产物/文档一致性审计报告.md` 结论为准。

## 铁律（违反 = 审查失败）

1. **禁硬编码本机路径**：源码/伪代码中不得出现 `C:\`、`/mnt/`、`/home/`、`/Users/`、`/tmp/` 等机器相关路径。工作区产物一律 `ctx.fs`/注入的工作区根派生；全局缓存（`~/.cicada`）由宿主插件**直写 node:fs** 到**调用方解析的目录**（绝对路径常量禁止；`resolveDshHome(configured)` 由 P2+ 的 home 模块提供）。
2. **坐标 = G（0.01mm 整数）**：`mm = G/100`、`0.01mm = 100 IU`；所有 pin/端点/连接判定 `G` 整数**精确相等**（禁止浮点比较）。
3. **transform 单一权威 = `cicada-deriver/src/transform.ts`**：deriver 与工具层必须复用同一模块，禁止各写一份。
4. **-0 归一**：旋转/解析可能产出 `-0`；`keyOf`/转换输出必须把 `-0` 当作 `0`（`"-0"` 与 `"0"` 是不同连接键 → 静默断网）。
5. **类型单一权威点**：`format/src/types.ts`（文件模型）、`deriver/src/view.ts`/`naming.ts`（语义模型/NETn）、`runtime/src/{tools,errors}.ts`（工具 schema/错误码，P3）。
6. **解析 fail-closed**：白名单外 token 抛 `symbol_unsupported`；`mirror` 拒绝（翻转 transform）；连接中性字段可容忍。
7. **测试原则**：不为凑绿给源码打补丁/放宽断言/跳过用例；发现缺陷修**根因**（`-0` 是源头归一、盒子取偶是公式层面修正）。测试失败 = 找出真 bug。
8. **已知量化限制（记录，非 bug）**：40mil 图形尺寸（如 1.016mm）与 25mil 半格（0.635mm）在 0.01mm 网格下 ≤0.005mm 漂移——**仅影响图形；连接点自洽**（所有消费者读取同一 mm 文本）。

## 包与命名

- host 包名 `@deepseek-ai/dsh-cicada-<name>`；服务键小驼峰（`cicadaFormat`/`cicadaDeriver`/`cicadaSymbols`/`cicadaRuntime`...）；plugin 入口 = 命名导出 `name`/`apply`（函数插件）或服务类 + `ctx.effect(() => ctx.provide(...))`；`declare module '@deepseek-ai/cordis'` 合并 Context/Events。
- `src/types.ts` 只放类型；测试在包级 `tests/`；`t/` 覆盖生成物必须可被自家 `parse`+`validate` 双绿。
- 每包含 `README.md`（目的/边界/已知限制）；组级 README 见 `packages/cicada/README.md`。
