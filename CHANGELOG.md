# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

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
