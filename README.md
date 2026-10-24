# dsh-wos-pipeline

> 把「Web of Science 查文献 → 下载 PDF → 解析 → 建知识库」这条长流程，变成一本**有类型、可续跑、会拦错**的账本。

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的插件。它不替你做检索和下载（那些由浏览器工具与解析插件完成），
它负责**状态机、数量闸门、文件收编与审计**——把最容易被模型"想当然"的环节变成结构约束。

## 它解决什么问题

一条文献流水线真正的事故点不在"能不能跑"，而在：

| 事故 | 本插件怎么拦 |
| --- | --- |
| 模型自己改检索词把 N 调进区间，用户不知情 | `wos_import_records` 核对检索式，不一致直接拒绝；改式子只能走 `wos_query_revise(confirmedByUser: true)` |
| 文件名凭摘要臆测，内容与文件名不符 | 文件名只由 WOS 的 `TI/J9/PY` 生成，收编时强制验 `%PDF-` |
| 1.3 MB 的 HTML 壳被当成 PDF | 首字节不是 `%PDF-` 直接判 fail 并留原因 |
| 账本说下载了 20 篇，磁盘上只有 18 个 | `wos_download_audit` 全库逐文件验头 + 与 ✅ 行数对账 |
| wiki 生成器写死层目录，新增层静默丢失 | `wos_wiki_index` 扫描层列表来自代码常量，并校验「扫描总数 == 分层求和」 |
| 一轮跑崩了不知道从哪接 | `run.json` 记阶段、闸门、迭代历史、逐条状态；`wos_run_status` 给出下一步该调哪个工具 |

## 阶段状态机

```
created → imported → classified → downloading → downloaded → parsed → wiki
  建账本    过闸门      分级        选梯度+下载      收编审计      解析回填    建知识库
```

每次推进都有前置条件，不满足就拒绝并说明该补哪一步。`records.md` 是账本的**只读视图**（由 `run.json` 渲染），
模型没有直接写它的路径——从结构上消灭了「手改 Markdown 表把四张表改坏三张」这类事故。

## 15 个工具

| 阶段 | 工具 | 作用 |
| --- | --- | --- |
| created | `wos_run_create` | 建账本（主题 + 已确认检索式） |
| | `wos_run_status` | 阶段、计数、闸门、迭代历史、下一步；不带参数则列出所有 run |
| imported | `wos_import_records` | 解析 WOS Full Record 导出、判闸门、记迭代历史（`query` 必填并核对） |
| | `wos_query_revise` | 改检索式，**强制 `confirmedByUser`**；超过轮次上限还需 `userDecided` |
| classified | `wos_records_query` | 分页读记录（可按分级/状态过滤，可选摘要） |
| | `wos_records_update` | 批量写分级/下载/解析状态与梯度（任一条非法整批拒绝） |
| downloading | `wos_download_plan` | 按梯度+出版商分组，给 DOI 链接、规范文件名、该出版商的 PDF 取法 |
| | `wos_pdf_intake` | 验 `%PDF-` → 规范改名 → 移入 `downloads/` → 标记 ok |
| | `wos_download_audit` | 全库验头 + 对账 + `_quarantine/` 隔离 + 文件名/标题低重合可疑项 |
| parsed | `wos_parse_plan` | 待解析清单 + 可直接照抄的 `async_parse_pdf` 调用 |
| | `wos_parse_audit` | 扫盘找 `full.md` 回填（`apply:false` 只报告） |
| wiki | `wos_wiki_init` | 建骨架，**默认只预览**，`confirm: true` 才落盘 |
| | `wos_wiki_stage_raw` | 全文落 `raw/papers/`，补 `source_url/ingested/sha256`，同源重跑按 sha256 跳过 |
| | `wos_wiki_lint` | 断链/孤儿/index 漏登/标签白名单/超行数/raw 漂移/漏扫层 |
| | `wos_wiki_index` | 重生 `index.md` + `_meta/BUILD_REPORT.md`（五层全覆盖） |

## 三条硬规则（写进代码，不只是文档）

1. **闸门未过时，检索词由用户定。** 默认区间 50–300（可配）。N 出区间 → 报 N + 诊断 + 2–4 条候选式子 → 等用户选定 → `wos_query_revise(confirmedByUser: true)`。
   `wos_import_records` 会核对 `query` 与账本是否一致，不一致抛 `QUERY_CHANGED_UNCONFIRMED`。轮次上限（默认 3）到顶后必须 `userDecided: true` 继续，或 `acceptOutOfRange: true` + `acceptReason` 明确豁免（豁免写进账本）。
2. **人机验证一律交用户，完成判据只用正向信号。** 用 `textExists: "<论文标题片段>"` 或文章页独有的 `urlContains`；
   **不要用 `textMissing`**（挑战 iframe 重载瞬间会假满足，帮助流程立即返回 `completed`，用户还没动手）。
   `bsk_session start` 默认后台开窗，prompt 里要让用户切到 Agent 窗口。
3. **单线程 + tab 收敛。** 同一时刻只允许一个下载；`target=_blank` 每点一次开一个新 tab，**收编后立刻 `bsk_tabs close`**，agent tab 应恒为 1。

## 安装

### 从 npm（推荐，可被市场检测更新）

```bash
# 在 DSH profile 目录
npm i dsh-wos-pipeline
```

然后在 profile 的 `cordis.patch.yml` 里加一行（或直接使用包内 `cordis.patch.yml` 提供的 bundle patch）：

```yaml
- id: wos-pipeline
  name: 'dsh-wos-pipeline'
  config:
    runsRoot: 'D:/path/to/your/articles'
    wikiRoot: ''
    gate: { min: 50, max: 300, maxAttempts: 3 }
    pageSize: 20
```

### 本地开发

```bash
git clone <this repo>
cd wos-pipeline
npm test          # 87 条断言，不需要网络与浏览器
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `runsRoot` | 空 | 任务目录父目录；空则回落 Host 进程 cwd，**建议显式设置** |
| `wikiRoot` | 空 | 空 = `<任务目录>/LLM_WiKi_KnowledgeBase`（建之前工具先返回预览让用户确认） |
| `gate.min` / `gate.max` | 50 / 300 | 数量闸门区间 |
| `gate.maxAttempts` | 3 | 检索式迭代轮次上限 |
| `pageSize` | 20 | `wos_records_query` 默认页大小 |

## 依赖

- **必需**：DSH 本体（提供 `tools` 服务与浏览器插件）
- **解析阶段需要** [`dsh-pdf-mineru`](https://www.npmjs.com/package/dsh-pdf-mineru)：本插件不重造 MinerU 客户端，
  只负责"该解析哪些、产物该落在哪、状态怎么回填"。未安装时前四个阶段仍可正常使用。
- **不需要任何 skill**：七个阶段的口径全部内置于 `data/playbook/*.md`，由工具在合适的时点带出来。
  唯一相关的是 `browser-skill` —— 它负责给 `bsk_*` 浏览器工具开权限（懒注册），不是流程 skill；
  不装它则下载阶段无法动浏览器。曾与其重复的 `wos-literature-pipeline` / `llm-wiki` /
  `doi-pdf-batch-download` 三个 skill 已退役，避免模型同时看到两套口径。

## 任务目录结构

```
wos_<主题>_<日期>/
├── run.json              # 账本（唯一写入方是插件）
├── records.md            # 只读视图，由 run.json 渲染
├── savedrecs.txt         # WOS 导出原件
├── downloads/            # 规范命名的 PDF + 每篇的 full.md 产物目录
├── _quarantine/          # 重复件/无主文件隔离（隔离优于删除）
└── LLM_WiKi_KnowledgeBase/
    ├── SCHEMA.md  index.md  log.md
    ├── papers/ entities/ concepts/ comparisons/ queries/
    ├── raw/papers/       # 不可变源（带 sha256，可查漂移）
    └── _meta/PROCESS.md  _meta/BUILD_REPORT.md
```

## 测试

```bash
npm test
```

- `test/smoke.mjs`：闸门硬规则、豁免、收编（合法/HTML 壳/过小）、审计、解析回填、wiki 幂等与 lint、lossless JSON
- `test/load.mjs`：15 个工具契约形状、无重名、账本 v1→v2 迁移
- `test/tools-exec.mjs`：直接调 `execute` 验证返回值形态与硬规则拦截；**默认用临时 run**，不会碰真实账本

## 已知限制

- 只解析 WOS 的 **Plain text + Full Record** 导出；其它格式会解析出 0 条并报错。
- 出版商权限、Cloudflare 挑战、MinerU 网关可达性都不由本插件控制，插件只负责把失败**如实记录**。
- 阶段推进是线性的：选中梯度全部下载完才进 `downloaded`，因此长跑时 wiki 无法增量推进（后续可能加 `allowPartial`）。

## License

MIT
