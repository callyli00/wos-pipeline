# 跨阶段红线（每轮首次 status 时给一次）

**🔴 R1 闸门未过，检索词必须与用户一起定**

N 出 50–300 区间时，**不许自己加词、删层、改字段、换运算符**。必须：报 N + 给诊断 + 给 2–4 条候选式子（各写清会留下什么、会漏什么）→ 等用户选定 → `wos_query_revise(confirmedByUser: true)` → 重跑。
插件在 `wos_import_records` 里核对 `query` 与账本是否一致，不一致直接拒绝；**这是结构约束，不是提醒**。

**🔴 R2 轮次上限到顶就交人**

默认 3 轮。到顶仍未进区间：把历次 N 与式子整表摆给用户，二选一——继续修订（`userDecided: true`）或豁免闸门（`acceptOutOfRange: true` + `acceptReason`）。豁免会写进账本。

**🔴 R3 人机验证一律交用户，且完成判据只能用「正向信号」**

页面出现 CAPTCHA / Turnstile / 「Are you a robot?」/「请稍候」/ 滑块 / 点选图 → **立刻 `bsk_assist request-help` 交给用户**。
不要自己点、不要靠反复刷新硬撞。唯一例外是 Cloudflare 的「Just a moment…」自动放行窗口：先等 8–10 秒重新 observe 一次，仍不通过就交人。

**交接必须走工具，别手搓**：先调 `wos_human_verify`（不带 `resolved`），用 `titleText`（论文标题片段）或 `urlContains` 作判据。它会：

1. 把「已交给用户」写进账本；
2. **直接返回该原样调用的 `bsk_assist` 参数**（判据已构造成正向信号；`textMissing` 之类会被工具拒收）；
3. 在你收口前**拦住 `wos_download_plan`**。

用户做完后调 `wos_human_verify {resolved:true, outcome:"passed"}` 收口。没有交接记录就继续往下跑，等于把用户关在门外——实测就是这么卡死的。

**`completionCriteria` 只能用正向信号**（`textExists` / 有区分度的 `urlContains`）：

- ❌ **不要用 `textMissing`**：挑战 iframe 自己会重载，重载那一瞬间「某段文字消失」→ 判据假满足 → 帮助流程立即返回 `completed`，用户还没动手，等于没等。
- ❌ **不要用挑战页也挂着的 URL**：ScienceDirect 的挑战页 URL 里就带 `/science/article/pii/...`，用它当完成信号会瞬间「完成」。
- ✅ 正例：`{ all: [{ textExists: "<论文标题片段>" }], stableForMs: 2000 }`——标题在挑战页绝不可能出现。

**Agent 窗口默认在后台**（`bsk_session start` 的 `noFocus` 默认 true）：request-help 的 prompt 里必须明确让用户「切到 DSH 的 Agent 窗口」，否则他看不到验证页。

**Cloudflare 校验是每请求的**：用户过完某页后，你再发起新导航（含 reload）会生成**新的** challenge（reference number 会变）。
所以「用户过校验 → 我重试」这个闭环对逐请求校验的站不成立——让用户在窗口里完成**最终那次**导航，我只负责收编落盘文件。

超时/取消后**不要重复发同一个 request-help**（协议禁止），先 observe 看实际状态。**绝不 `bsk_session stop`**：会连浏览器一起关掉，验证页随之消失，用户就没得做了。

**⚠️ `request-help` 只用于「人机验证」，别的一律自己解决**

只有一种情形可以把操作推给用户：**页面要求人工证明自己是人**（hCaptcha / reCAPTCHA / 滑块 / 点选图）。除此之外——找不到按钮、菜单点不动、ref 过期、导出对话框没出现——都是**本机可解的技术问题**，必须自己解决；把可自动化的 UI 操作抛给用户是失职，也是流水线最致命的卡点。

**无 ref 的元素怎么点（按顺序试，不要瞎猜属性，更不要数位置）**

1. **ref 优先**：observe 拿到的 `@eN` 最稳；任何改变 DOM 的交互之后 ref 立刻失效，重新 observe 再点。
2. **用 `extract` 把「标签 → 稳定定位器」算出来**（首选，代替一切猜测）：
   `bsk_inspect { action:"extract", extractKind:"list", selector:"<容器>", itemSelector:"button", extractFields:{"fields":[{"key":"label","selector":":scope","read":"text"}]} }`
   返回的 `row_sources[].locator` 与 `rows[].label` 一一对应——先按文本核对，再点那个 locator。菜单/列表项通常带 `id`（如 Export 菜单的 `#exportToFieldTaggedButton`）。
3. **确证存在的语义选择器**：如 `#export-trigger-btn`、`[aria-label="summaryRecordsTop"]`。
4. **键盘导航只作为最后手段**，且必须**先核对再按**：`ArrowDown` 每次前进一项、`Enter` 激活——但项位置会随菜单增删变化，按错可能触发「加到我的人主页」这类副作用且不易察觉。除非当前菜单项在结构里能逐项核对，否则不要用。
5. **绝不猜 `data-ta` / `aria-label` 的具体值**：WOS 新版实测 `[data-ta="export-option-plain-text"]`、`button[aria-label="Export"]`、`[data-ta="export-button"]` 全部落空。

判断用哪条的依据永远是 observe / extract 的结构输出，不是记忆。

**人机验证的结构特征（处置见上方 R3，此处只列识别方法）**

- Cloudflare「请稍候 / Just a moment」：先等 8–10 秒重新 observe 一次，多数自动放行；仍不过按 R3 交人。
- hCaptcha / reCAPTCHA：`dialog` + `Iframe "hCaptcha挑战"` + `Challenge Image 1..9` 节点。
- 结构化完成判据一律按 R3 写（**正向信号**，禁止 `textMissing`）。
- **绝不 `bsk_session stop`**：会连浏览器一起关掉，验证页随之消失，用户就没得做了。
- 用户回来后重新 observe，确认 `dialog`/`Iframe` 消失才继续；不替用户点、不猜已通过。

**🔴 R4 标签页必须收敛：一个工作 tab，点开一个关一个**

**tab 会越滚越多**——`target=_blank` 的链接（如出版商文章页的 `View PDF`）每点一次就开一个新 tab，
而且**会话的活动 tab 会跟着切到新 tab**，于是下一次 `navigate` 又落在新 tab 上，十几个 tab 就堆出来了。实测跑 11 篇留下 10 个残留 tab。

规矩：

1. 开工时 `bsk_tabs {action:"create"}` 建**一个**工作 tab，之后所有 `navigate` 都复用它（不要每次新建）。
2. 凡因点击而**新开的 tab**（PDF 查看页、下载页、登录跳转页），在**文件落盘并收编之后立刻 `bsk_tabs {action:"close", tabId}`**——不要攒到最后。
   - 关闭前必须确认下载已经完成（先看 `Downloads` 有新文件 / `wos_pdf_intake` 返回 ok），否则可能中断下载。
   - 只关**自己开的** tab，绝不碰用户的 tab。
3. 每完成一篇/一批，`bsk_tabs {action:"list", scope:"agent"}` 自查一次：agent tab 数应恒为 1。
4. 任务收尾：`bsk_tabs close` 掉自己开的那一个，`scope:"all"` 复核只剩用户的 tab。

**用自己的标签页**：干活前先 `bsk_tabs {action:"create", url:"…"}` 开自己的 tab，不要占用用户当前标签；同一任务内复用这个 tab，收尾时 `close` 掉自己开的那一个。

**不用视觉识别**：一律用 `bsk_inspect` 的 `observe` / `html` / `extract` 读结构判断页面状态，不用 `screenshot`，也不要依赖看图下结论——很多执行环境下模型不支持视觉。hCaptcha / reCAPTCHA 之类也会以 `dialog` + `Iframe` + `Challenge Image N` 的节点形式出现在 observe 里，足够判定。

**下载目录用完即清**：浏览器下载目录（默认 `%USERPROFILE%\Downloads`）是用户的，不是任务工作区。每次导出/下载之后**立刻收编并清理**：

- 规范件移入 run 目录（`downloads/` 或 run 根，按阶段），文件名按规范生成；
- 重复件（`xxx (1).txt`、`xxx (2).pdf`）与暂不用的中间件放进 `_quarantine/`，**不要直接删**——隔离优于删除：曾有被判为废件的文件事后证明是真件；
- 收尾时确认该目录已无本任务残留（`Get-ChildItem $Downloads | ? Name -like '<已知前缀>*'` 为空）；
- **只动本任务产生的文件**：按已知文件名 + 本次时间窗判断，绝不碰用户早于任务下载的东西。

**浏览器工具是 lazy 的**：`bsk_*` 只在加载 `browser-skill` 技能后才注册。要用浏览器先 `skill("browser-skill")`；在那之前这些工具不存在，属预期行为，不是故障。

**验证而非假设**：页面状态一律用 snapshot 的内容特征判断，不要用 console；任何改变 DOM 的交互之后重新取 ref 再点。所有默认值以实际 snapshot 为准，不以记忆为准。

**改完必复验**：任何批量写入之后在同一轮重读并核对结构（条数、必填字段、表头唯一）。账本由工具写，模型不手写。
