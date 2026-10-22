# 阶段 parsed：PDF → Markdown 口径

解析**不在本插件里做**：交给已装的 `dsh-pdf-mineru`（自建网关 provider）。本插件只负责
「该解析哪些、产物落在哪、状态怎么回填」。这样不会出现两套 MinerU 客户端、两个 token 配置。

## 流程

1. `wos_parse_plan` 拿待解析清单：每条带 PDF 绝对路径、目标目录、以及三步可照抄的调用。
2. 逐篇 `async_parse_pdf({ file_path })` 提交解析。
3. `read_pdf({ file_path, focus: "artifacts" })` 取产物路径（缓存里）。
4. 把产物复制到 `downloads/<PDF 主名>/`，**full.md 必须叫 `full.md`**（图片目录与 sidecar 一起带上，溯源零成本）。
5. `wos_parse_audit({ apply: true })` 扫盘回填账本。`apply: false`（默认）只报告，先看一眼再落账。

## 判据

- `downloads/<PDF 主名>/full.md` 存在 = 解析完成；不存在 = 未解析（不看缓存、不看日志）。
- 单篇失败不阻塞同批：`wos_records_update` 标 `parse: { status: "fail", failReason }` 继续下一篇。
- 幂等：已解析的跳过，重跑只补失败项。

## 节奏

- 一次提交 20–40 篇，别一口气 200 篇（上下文与超时都会炸）。
- 大文件（> 50 MB）单独提交，超时阈值放宽。
- 解析产物留在 `downloads/` 内不搬走：PDF 与 full.md 同名同目录，溯源零成本。
