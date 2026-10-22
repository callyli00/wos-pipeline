# 阶段 wiki：llm-wiki 建库口径

三层架构：`raw/`（不可变源）→ wiki 页（`papers/` `entities/` `concepts/` `comparisons/` `queries/`）
→ `SCHEMA.md`（约束）。机械部分由插件工具做，页面内容由你读全文后写。

## 顺序（不可跳）

0. **先定位置、并让用户确认**：默认建在**任务目录内** `<run 目录>/LLM_WiKi_KnowledgeBase`（整个任务可一起搬走/归档）。
   `wos_wiki_init` **不带 `confirm: true` 时只返回预览**（解析出的绝对路径、将创建与已存在的文件），
   **不写任何文件**。把这个路径摆给用户点头，再带 `confirm: true` 真正创建；要换位置就在这一步传 `wikiRoot`。
1. `wos_wiki_init`：建骨架，`_meta/PROCESS.md` 已按账本预填每篇一行。
2. `wos_wiki_stage_raw`：把已解析全文复制进 `raw/papers/<PDF 主名>/` 并补 raw frontmatter（source_url / ingested / sha256）。同源重跑按 sha256 判等，一致跳过、不一致报 drift。
3. **Orient 先行（CRITICAL）**：建页前必须读 `SCHEMA.md` + `index.md` + `log.md` 尾部 20–30 条。跳过必造重复页、漏交叉引用。
4. Bulk Ingest：先读全源 → 跨源识别 entities/concepts → **一次搜索**查已有页 → 一次通过创建/更新 → `wos_wiki_index` 最后只更新一次 → 单条 log 覆盖整批。
5. `wos_wiki_lint` 收口，按报告补链接与标签。

## 建页规则

- **每篇文献必建 paper 页**；entity 默认尺度 = 每篇的第一作者 + 通讯作者（多通讯全建）。
- Page Thresholds：2+ 源出现或对单源核心才建页；顺带一提不建；> 200 行拆页。
- 每页 **≥ 2 条出站 `[[wikilinks]]`**；entity/concept 页还要被至少 1 个内容页链入。
- `sources` 一律**带引号的列表**（`sources: ["raw/papers/013_..._Fe,Co,Ni.../full.md"]`）——目录名带逗号，不加引号会被切成两个源。
- 综合 3+ 源的页面在段末加 `^[raw/papers/xxx/full.md]` 溯源标记。
- `confidence`：≥3 个实质源综合 = high；单源主导或材料薄 = medium/low。
- 标签只能取自 `SCHEMA.md` 的 `## Tag Taxonomy` 代码块；新标签先登记再使用。
- 矛盾按 Update Policy：双立场并记（带日期与来源）+ `contested: true` + 提交用户复核，不静默覆盖。
- `papers/README.md` 是自动目录、**不是 wiki 页**：禁 `[[wikilink]]`，否则污染图谱。

## 五个坑（都是实跑踩出来的）

- **index 生成器必须覆盖全部层**：写死 `papers/entities/concepts` 会让后续新增的 `comparisons/` `queries/` 静默丢失，且不报错。判据：`扫描总数 == 分层求和`，不等就是漏扫（`wos_wiki_index` 会打印这个校验）。
- **entity slug 变体要合并**：`RP` 行是「姓, 首字母」（`Dugnani, R`），`AF` 是全名（`Dugnani, Roberto`）。补建前先按（姓 + 首字母）比对已有页，否则同一人两个页。
- **通讯作者只认 WOS `RP` 字段**：按 byline 末位或 `*` 号猜会错。
- **frontmatter 标量别用 dump 类工具**：会带 `...` 把 YAML 文档截断。本插件用 JSON 序列化标量，手写页面时照此办理。
- **大段追加要限流**：往长文件（如 `_meta/ingest-notes.md`）追加时单次控制在 ~6K token 内，否则容易超时；拆 2–3 次写。
