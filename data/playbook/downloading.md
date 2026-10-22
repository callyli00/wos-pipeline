# 阶段 downloading：下载纪律

按**出版商分组**集中下载，不要按记录序号打散——同一家的会话级校验只需过一次。

**🚨 单线程、一篇一篇来**：同一时刻只允许有一个下载在跑。**不要并发开多个 tab、不要并行导航多个 DOI、不要批量提交**——并发是最容易触发 Cloudflare 挑战与机构 IP 封禁的行为。
每篇的完整闭环是：**在工作 tab 里**导航 → （必要时交用户过验证）→ 点 PDF 链接（会开新 tab）→ 确认落盘 → `wos_pdf_intake` 收编 → **关掉那个新开的 tab** → 下一篇。

> **tab 必须收敛**（见 R4）：出版商的 PDF 链接多是 `target=_blank`，每点一次开一个 tab，且活动 tab 会跟着切过去。
> 收编完成后立刻 `bsk_tabs {action:"close", tabId}` 关掉它，并定期 `bsk_tabs {action:"list", scope:"agent"}` 自查——agent tab 应恒为 1。
> 实测跑 11 篇不关会留 10 个残留 tab。

- 导航到 `https://doi.org/<DOI>`，在文章页取 PDF 链接后**直接导航该直链**。`net::ERR_ABORTED` 是下载信号，不是失败。
- `utf-8 codec can't decode byte` 说明响应被当文本读了，文件通常已经落盘，先去下载目录看。
- 逐篇验 `%PDF-` 头；HTML 壳、`(1).pdf` 后缀、跨篇错配都是常态，收编时要核对内容归属而不是只看文件名。
- 失败不阻塞：标 ❌ + 原因继续下一篇；no DOI 的记录走 WOS 的「Full text at publisher」入口。
- 收尾：`✅` 行数 == `downloads/` 实际 PDF 数，且全库 `%PDF-` 通过。

## 各家取 PDF 的稳定路径（实测）

| 出版商 | 取法 | 备注 |
| --- | --- | --- |
| MDPI | 直连 `https://www.mdpi.com/<ISSN>/<vol>/<issue>/<id>/pdf` | 全 OA，`ERR_ABORTED` 即下载，最省事 |
| Elsevier | 文章页**点** `a[aria-label^="View PDF"]`（`target=_blank`，开新 tab 并落盘）→ 收编后**关掉这个新 tab** | **实测直接导航 `pdfft` 会被当 inline 在阅读器里打开、不落盘**；点链接才下载。落盘名 `1-s2.0-<PII>-main.pdf` |
| Wiley | `https://<sub>.onlinelibrary.wiley.com/doi/pdfdirect/<DOI>` | `/doi/pdf/` 会超时 |
| Springer | `https://link.springer.com/content/pdf/<DOI>.pdf` | 302 回文章页 = 无订阅，直接判 fail 省时间 |
| RSC | 主格式超时就降级 `https://pubs.rsc.org/en/content/articlepdf/<YEAR>/<journal>/<ID>` | CDN 会二次弹 Cloudflare |
| IOP / APS / ACS | 文章页 PDF 直链（`/article/<DOI>/pdf`、`/pdf/<DOI>`、`article-pdf/...`） | ACS/IOP 常带 Cloudflare |

## 🚨 Cloudflare / hCaptcha：一律交用户，判据只许正向

1. 见到 `Are you a robot?` / `Just a moment…` / `请稍候` / 滑块 / 点选图 → **先等 8–10 秒重新 observe 一次**；仍不过就 `bsk_assist request-help` 交给用户。
2. **`completionCriteria` 只能用正向信号**：
   - ✅ `{ all: [{ textExists: "<文章标题片段>" }], stableForMs: 2000 }`
   - ❌ 不要用 `textMissing`：挑战 iframe 重载瞬间会假满足 → 立即返回 `completed`，用户根本没动手。
   - ❌ 不要用挑战页也挂着的 URL：ScienceDirect 挑战页 URL 就带 `/science/article/pii/...`。
3. **prompt 里必须让用户切到 DSH 的 Agent 窗口**——`bsk_session start` 默认 `noFocus: true`，窗口在后台，不切过去他看不到验证页。
4. **Cloudflare 校验是每请求的**：用户过完某页后，你再导航（含 reload）会生成**新的** challenge（reference number 会变）。
   所以正确姿势是：让用户在窗口里完成**最终那次**导航；我只负责收编落盘的文件，不再重试导航。
5. 超时/取消后不要重复发同一个 request-help；先 observe 看实际状态。**绝不 `bsk_session stop`**（会关掉浏览器，验证页消失）。

## 收编注意（EBUSY）

Chrome 常会继续占用刚下好的文件：`fs.unlink` 报 `EBUSY` 时**目标文件其实已经就位**，
`wos_pdf_intake` 会返回 `leftoverSource: true` 提示「已收编成功、源文件残留待清」。
收尾时把 Downloads 里的同名残留隔离进 `_quarantine/`，不要因为删不掉就重下一遍。

**页面状态只看结构**：用 `bsk_inspect` 的 `observe` / `html` / `extract` 判断，**不用 `screenshot`、不靠看图下结论**（很多执行环境不支持视觉）。出版商页面的 Cloudflare/hCaptcha 也从 `dialog` / `Iframe` 节点识别。
