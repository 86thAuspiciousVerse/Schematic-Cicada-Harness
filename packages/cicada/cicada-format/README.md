# @deepseek-ai/dsh-cicada-format

Schematic-Cicada 的 `.cicada_sch` 文件格式层：S-expression 词法、白名单 fail-closed 解析、规范序列化、结构校验。

- 坐标统一为 `G`（0.01mm 整数），`mm = G/100`；KiCad 内部 100nm（0.01mm = 100 IU）。
- 真相文件 version `20260803`（SEXPR_SCHEMATIC_FILE_VERSION）；导出副本 `20250114`（KiCad 9+）。
- 白名单外 token → `symbol_unsupported`（fail-closed，绝不静默丢弃）。
- 仅提供服务（`cicadaFormat`），无工具、无 DSH 组合层依赖；被 `cicada-deriver` / `cicada-runtime` / `cicada-editor-bridge` 消费。
