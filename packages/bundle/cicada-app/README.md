# @deepseek-ai/dsh-cicada-app

Schematic-Cicada 产品组装 bundle：在 `dsh-web-app` 之上的 patch 层，负责产品表面值（回环 127.0.0.1:3123）与 cicada 领域插件挂载。

- 组合链：`dsh-base ← dsh-web-app ← dsh-cicada-app`（profile manifest 层叠）。
- patch 规则：整行重述 config；`disabled: true` 而非删行（见 `cordis.patch.yml` 顶注）。
- 保留行：P3/P4/P6 占位注释在 `cordis.patch.yml` 中，后续阶段按 id 挂行。

## Known Limitations and Deferred Work

- client 三包登记（dsh.client 行）与 ui-layout 替换：P4 落地（当前沿用 web-app 布局）。
- editor-bridge 行：P6 落地。
