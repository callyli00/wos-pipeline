# 阶段 created：写出检索式 → 跑检索 → 导出 → 导入

目标：把自然语言主题变成**字面上要敲进 WOS 检索框的那条式子**，跑到结果页，导出 Full Record，落进账本。

> 🔴 **检索词是用户的决定，不是你的。** 每条式子先与用户确认再敲进检索框；
> 闸门未过（N 出 50–300）时尤其如此——见 `imported` 阶段的硬规则。
> 插件在导入时核对 `query` 与账本是否一致，不一致直接拒绝。

## 检索式怎么写

- 维度从主题涌现，不套预设分类表；同维度变体用 OR，跨维度要求用 AND。
- 概念层先拆原子概念，再补同义词族：学术变体、缩写与全称、连字符与空格、单复数、通配符 `*`。拿不准的词先查证再写，不拍脑袋造。
- 字段默认 Topic(TS)；人名→AU、期刊→SO、精准需求→TI+AB。
- 短语是子串匹配：`"elastic strain"` 已覆盖 `high elastic strain`，不要堆修饰词。
- 提交前把**完整式子**给用户确认一次；确认后不要边搜边改。

## 浏览器前置（不做这一步会以为工具不存在）

`bsk_*` 只在加载 `browser-skill` 技能后才注册。开工先 `skill("browser-skill")`（或请用户敲 `/browser-skill`），工具在下一步出现。看到"没有 bsk_* 工具"不要判断成插件坏了。

## 页面状态只看结构，不做视觉识别

**不要用 `bsk_inspect action:"screenshot"`，也不要依赖截图下结论**——很多执行环境不支持视觉。

身份判定看标题与特征节点；人机校验看 `dialog` + `Iframe` + `Challenge Image N`；遮挡物从结构里找 `button "Close"`。都不要看图、不要靠坐标猜。

## 浏览器操作手册（2026-10-22 实跑 199 条验证通过）

### 1. 起会话，用自己的 tab

```
bsk browsers --json                      # 取当前实例 ID（每次可能变，不要沿用旧值）
bsk_session start { browser: "<实例ID>" }
bsk_tabs create { url: "https://webofscience.clarivate.cn/wos/woscc/advanced-search" }
```

不要占用用户当前标签；收尾 `bsk_tabs close` 自己开的那一个。

### 2. 表单有两种布局，别被坑

- **Query editor 布局**：一个 `textbox "Query Preview"`，可直接写整条 `TS=(...)`；`button "Search"` 在它下方。
- **行式 FIELDED SEARCH 布局**：`combobox` 字段（默认已是 **Topic**）+ `textbox "Search box 1 Topic"`；此时正文**不要带 `TS=` 前缀**，前缀由字段下拉承担。
- **QUERY BUILDER 常被激活且它的 Search 静默不提交**：看到 `button "Search" [disabled]` 或点了没反应，先确认当前是不是 FIELDED SEARCH，必要时点 `link "FIELDED SEARCH"` 切回去。

### 3. 先关 NPS 横幅，否则找不到 Search

`dialog "How likely are you to recommend the Web of Science…"` 会盖住底部的 Search 行，表现为**表单里根本没有 Search 按钮**。
找它里面的 `button "Close"`（通常在 dialog 末尾）点掉，Search 才会出现在观察结果里。

### 4. 提交与「提交后必有变化」

点 `button "Search"` 后，若观察到 `L1 modal cover=100%` 且 Search 变 `[disabled]`，说明有东西弹出——继续往下读结构判断是 NPS、hCaptcha 还是结果页。

### 5. hCaptcha：这是唯一需要请求人工协助的情形

结构特征：

```
dialog "There is unusual activity coming from your institution. Please verify you are human to proceed."
  Iframe "hCaptcha挑战"
    heading "找出可以在水下使用的物品"
    button "Challenge Image 1..9"
```

处置：`bsk_assist { action:"request-help", prompt:"…请切到 DSH 的 Agent 窗口…", completionCriteria:{ all:[{textExists:"<结果页独有的文本，如论文标题片段>"}], stableForMs:2000 } }`。

**判据只用正向信号**：不要用 `textMissing`（挑战 iframe 重载瞬间会假满足），也不要用挑战页同样挂着的 URL。
WOS 的 hCaptcha 过完之后落地的是结果页，用「结果页标题里的标题片段」或 `urlContains:"/wos/woscc/summary"`（WOS 挑战页不在这个 URL 上）都可以。
**不要 `bsk_session stop`**（会连浏览器一起关掉）。用户完成后再 observe 确认 `dialog`/`Iframe` 消失才继续。

### 6. 结果页身份 + 双计数

- 标题：`… – 199 – Web of Science Core Collection`
- 标题区：`heading "199 results from Web of Science Core Collection for:"`
- 页脚：`199 records matched your query of the 70,285,585 in the data limits you selected.`
- 两个数必须一致；不一致先查有没有残留 Refine 筛选。

### 7. Export 菜单：用稳定 id 点，不要数位置

`region "summaryRecordsTop"` 里两个触发器都有稳定 id：

- Export 按钮 → **`#export-trigger-btn`**
- 导出菜单是 Angular Material（`.mat-mdc-menu-panel`），**每个菜单项都有独立 id**：

| 菜单项 | 选择器 |
|---|---|
| EndNote Fusion | `#exportToEndNoteFusion` |
| EndNote desktop | `#exportToEnwDesktopButton` |
| EndNote online | `#exportToEnwOnlineButton` |
| Add to my researcher profile | `#addToMyResearcherProfile` |
| **Plain text file** | **`#exportToFieldTaggedButton`** |
| RIS | `#exportToRisButton` |
| BibTeX | `#exportToBibtexButton` |
| Excel | `#exportToExcelButton` |
| Tab delimited | `#exportToTabWinButton` |
| Printable HTML | `#exportToHtmlButton` |
| InCites | `#exportToIncitesButton` |
| WoS Research Intelligence | `#exportToRiButton` |
| Email | `#exportToEmail` |
| Fast 5000 | `#exportToFast5k` |

配方：`click #export-trigger-btn` → `click #exportToFieldTaggedButton`。

**不要用 `ArrowDown ×n + Enter` 这种按位置数的方法**：菜单一旦增删项就会导成别的格式（或触发"加到我的人主页"这类副作用），而且错了还看不出来。也不要猜 `[data-ta=...]` / `[aria-label="Export"]`——实测都不存在。

> 万一日后 id 变了：用 `extract` 拿「标签 → 定位器」映射再点，见下面第 11 条，**永远不要靠位置**。

### 8. 导出对话框固定设置（每次都要手改）

```
heading "Export Records to Plain Text File"
  radio "All records on page"   ← 默认勾这个，只导当前页，必须改
  radio "Records from:"         ← 点它，两个 spinbutton 已是 1 / N
  combobox "Filter by, Author, Title, Source"   ← 名字叫 Filter by，实际是 Record Content
  button "Export"
```

- 点 `radio "Records from:"` → `spinbutton` 起始 1、结束 N 自动填好。
- 点那个 combobox → 出现 `dialog "selectOptions"`，里面的 `option`/`button` **有 ref**，选 `button "Full Record"`。
- 确认 combobox 显示 `= "Full Record"` 后再点 `button "Export"`。

### 9. 文件落点 → 立刻收编 + 清理（不留残留）

导出文件落在 `%USERPROFILE%\Downloads\savedrecs.txt`；重复导出会变成 `savedrecs (1).txt`——**按最新时间戳取**，别拿错。

收编三步，做完再看下一张图：

1. 取本次导出的那个文件（时间戳最新 / `expectN` 能对上）；
2. 复制规范件进 run 目录（`<run>/savedrecs.txt`），并立刻 `wos_import_records` 落账；
3. **清空下载目录里本任务的残留**：把 `savedrecs*.txt` 全部移入 `<run>/_quarantine/`（重复件尤其不能留），确认 `Downloads` 里已无 `savedrecs*`。

原则：**Downloads 是用户的，不是任务工作区**；重复件进 `_quarantine/` 而不是直接删；只动本任务产生的文件，绝不碰用户更早下载的东西。P1 的 PDF 下载走同一套：每篇下来立刻移入 `downloads/` 并按 `TI/J9/PY` 改名，收尾再扫一遍残留。


### 10. 落账

`wos_import_records { dir, path, expectN }`：幂等，整份替换账本；返回 `imported / dropped / noDoi / gate`。

缺 DOI 是 WOS 元数据局限（中文刊、老会议论文集最常见），账本显式记 `null`，不要留空、不要编造。

### 11. 通用技巧：任何列表/菜单都能查到「标签 → 稳定定位器」

元素在 a11y 树里没有 ref（自定义下拉、菜单、卡片列表常见）时，**不要数位置、不要猜属性**，用 `extract` 让工具把定位器算出来：

```
bsk_inspect {
  action: "extract", extractKind: "list",
  selector: ".mat-mdc-menu-panel",          // 容器：确证存在的选择器
  itemSelector: "button",                   // 项
  extractFields: {"fields":[{"key":"label","name":"Label","selector":":scope","read":"text"}]}
}
```

返回的 `row_sources[].locator` 就是每项的真实选择器（本例是 `#exportToFieldTaggedButton` 这类 id），并且与 `rows[].label` 一一对应——**先按文本核对，再点那个 locator**，顺序无关、增删项也不会错。

同样的办法可以定位结果列表、Refine 面板、导出对话框里的控件。`selector` 拿不准时先 `extractKind: "discover"` 看有哪些容器，再用 `extractTarget` 精确取。

## 常见坑速查

| 现象 | 真相 | 处置 |
|---|---|---|
| 表单里找不到 Search | NPS 横幅盖住了 | 点 dialog 里的 `button "Close"` |
| 点 Search 无反应 | 停在 QUERY BUILDER | 切回 FIELDED SEARCH 再提交 |
| 字段 `All Fields` | 新 tab 首载默认值 | 改成 Topic，或整条式子带 `TS=` |
| 菜单项无 ref | 自定义组件未暴露语义（Angular Material） | 用 `extract` 取 `locator`（如 `#exportToFieldTaggedButton`），**不要数位置、不要按方向键** |
| 导出只有 10 条 | `All records on page` | 改 `Records from: 1 to N` |
| 导出缺摘要/DOI | Record Content 是默认值 | 改 `Full Record` |
