# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.3.1] - 2026-10-24

### Changed

- **去掉对 skill 的依赖**，插件成为唯一口径来源：
  - `data/playbook/wiki.md` 标题与措辞不再指向 `llm-wiki`；
  - `wos_parse_plan` / `wos_wiki_init` 的 `reason` 文案改为「按 wiki 阶段口径（playbook wiki.md）」，不再让模型去找一个已不存在的 skill；
  - `package.json` / `locale/zh.json` 描述更新，并注明「全流程不依赖任何 skill」；
  - README 依赖章节补充说明：唯一相关的是 `browser-skill`（它只是给 `bsk_*` 工具开权限，不是流程 skill）。
- 与本插件重复的三个 skill（`wos-literature-pipeline`、`llm-wiki`、`doi-pdf-batch-download`）已在本机退役到
  `~/.dsh/skills-retired-20261024/`，移出 skills 目录即可，随时可搬回。

### Why

插件已覆盖全部七阶段口径，但 skill 目录里仍并列着同名流程，模型可能加载 skill 而绕开插件的闸门、
守卫与账本——那等于把最容易被违反的三条硬规则（检索词确认、关 tab、交人验证）重新变回无人看守。

## [0.3.0] - 2026-10-24

把「忘关 tab」「没把人机验证交给用户」从**文档提醒**升级为**账本状态**。

### Added

- **浏览器作业守卫 `guard`**：
  - `wos_pdf_intake` 新增 `spawnedTabId`：登记待关 tab，返回值首字段 `mustDoNow` 给出确切关闭指令。
  - 新增 `wos_browser_hygiene`：上报已关 tab 与 `agentTabCount`；数量不为 1、或仍有待关 tab 时返回 `ok:false` 并记入 `violations`。
  - 新增 `wos_human_verify`：prepare 模式把交接写进账本并**直接返回该原样调用的 `bsk_assist` 参数**，
    判据只接受正向信号（缺 `titleText` / `urlContains` 抛 `CRITERIA_REQUIRED`）；resolve 模式收口。
  - `wos_download_plan` 在 `humanGate.pending` / 有待关 tab / 收编后未自检时返回 `blocked: true`
    （带 `requiredTool` / `requiredArgs`），不再给下一批。
  - `nextStep` 优先返回补救动作；`wos_run_status` 新增 `browserGuard` 与 `blocked` 字段。
- 工具数 15 → 17；测试断言 87 → 125（smoke 91 + tools-exec 34）。

### Changed

- 守卫用计数器 `intakesSinceHygiene` 判定，而不是比较时间戳——同一毫秒内的先后比较会失效（实测踩过）。

### Why

实测「把规则写进 playbook」不足以保证遵守：长循环里仍会留着下载 tab，遇到挑战也不调 `request-help`，
结果用户看不到验证页、无法介入。故把这两件事改由工具状态强制：没清干净就不给下一步。

## [0.2.2] - 2026-10-22

### Fixed

- discipline.md 里残留的旧版人机验证示例仍推荐 	extMissing 判据，与新增的 R3「只用正向信号」直接矛盾；
  已改为「只列识别方法、处置统一看 R3」，避免同一文件里两条互斥指令。

## [0.2.1] - 2026-10-22

仅版本号递增，无代码变更。

- 0.2.0 发布后 registry 传播较慢：元数据已可见时 tarball 仍 404（约 15 分钟后恢复 200），
  期间以 0.2.1 重发以确认发布通道通畅。两版代码完全相同，**0.2.0 未废弃**。

## [0.2.0] - 2026-10-22

从「只跑到 downloading 的半成品」变成 7 阶段闭环。工具 5 → 15 个。

### Added

- **检索式迭代历史**：`run.attempts[]` 记录每一轮的 N/判定/式子，`records.md` 增「检索式迭代」表。
- **闸门硬约束**：`wos_import_records` 新增必填 `query`，与账本不一致抛 `QUERY_CHANGED_UNCONFIRMED`；
  新增 `wos_query_revise`，强制 `confirmedByUser: true`，超轮次上限还需 `userDecided: true`；
  新增闸门豁免（`acceptOutOfRange` + `acceptReason`），豁免理由写进账本。
- **下载收编**：`wos_download_plan`（按梯度+出版商分组、带 PDF 取法提示）、`wos_pdf_intake`
  （验 `%PDF-` → 按 `TI/J9/PY` 规范改名 → 移入 → 记 ok）、`wos_download_audit`（全库验头+对账+隔离+可疑项）。
- **解析编排**：`wos_parse_plan` / `wos_parse_audit`，复用 `dsh-pdf-mineru`，产物统一落 `downloads/<PDF 主名>/full.md`。
- **知识库能力**（llm-wiki 机械部分）：`wos_wiki_init` / `wos_wiki_stage_raw` / `wos_wiki_lint` / `wos_wiki_index`，
  含 raw sha256 幂等、五层扫描、`扫描总数 == 分层求和` 校验。
- 账本 **schema v2**，并提供 v1 自动迁移。
- 三个测试套件（smoke / load / tools-exec），共 87 条断言。

### Changed

- `wos_run_status` 增加 `attempts`、`pending`、`wiki`、`gateInteraction`。
- 收编失败也写账本（`status: fail` + 原因），不让坏文件静默占位。
- 下载计划解析器新增 WOS `PU`（出版商）字段用于分组。

### Fixed

- **lossless JSON**：闸门未过时 `next.args` 里的 `userDecision: undefined` 会让 host 判为有损输出
  （`tool returned invalid output`）。改为条件展开，并在 `index.js` 加 JSON 往返兜底 + 逐阶段断言。
- **`nextStep` 误触发交互**：`verdict: 'pending'`（还没导入过）时也走「请用户改检索词」分支，改为只在
  `too-narrow` / `too-wide` 时触发。
- **`wikiRoot` 默认落到系统临时目录**：`baseRoot()` 回落到 Host 进程 cwd，实测是 Temp 目录。
  改为默认 `<任务目录>/LLM_WiKi_KnowledgeBase`。
- **EBUSY 误判失败**：Chrome 占用刚下载的文件导致 `unlink` 失败时，已复制成功的 PDF 被判成失败。
  现在返回 `leftoverSource: true` 提示清残留。
- **`stageRaw` 写入多一个换行**导致 sha256 对不上、重跑无法跳过。

### Security / 体验

- `wos_wiki_init` 改为**默认只预览**（路径、将创建/已存在的文件），`confirm: true` 才落盘；
  `wos_wiki_stage_raw` 拒绝未初始化路径（`WIKI_NOT_INITIALIZED`）。
- `classified.md` 判据去掉了写死的「Ni 基合金」例子，改为通用口径。

## [0.1.0] - 2026-10-22

### Added

- 初始版本：`wos_run_create` / `wos_run_status` / `wos_import_records` / `wos_records_query` / `wos_records_update`。
- 账本 `run.json`、只读视图 `records.md`、50–300 数量闸门、阶段推进到 `downloading`。
