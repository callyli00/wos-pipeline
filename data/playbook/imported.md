# 阶段 imported：数量闸门

目标：确认 N 落在 50–300 区间（可在插件配置里改）。

## 🚨 硬规则：闸门未过时，检索词必须与用户一起定

**N 出区间 → 停下来，把选择权交给用户。模型不得自行加词、删层、改字段、换运算符。**

每次闸门未过，按这个顺序做：

1. 报出**当前 N** 与**判定**（过窄 / 过宽，以及偏离多少）。
2. 给出**诊断**：为什么会偏（AND 层过多 / 同义词太窄 / 体系词过度限定 / 缺约束层 / 裸词泛化 / 字段太宽）。
3. 给出 **2–4 条候选检索式**，每条都写清「会留下什么、会漏什么」——不要只给「推荐项」。
4. **等用户选定**，再调 `wos_query_revise`（`confirmedByUser: true`），然后重跑检索 → 重新导出 → 重新导入。

`wos_import_records` 会核对 `query` 与账本是否一致，不一致直接拒绝（`QUERY_CHANGED_UNCONFIRMED`）——
**这条校验就是硬规则的执行点**，绕过它的唯一办法是 `wos_query_revise`，而那要求用户确认。

## 诊断口径

- `too-narrow`（N<50）：先怀疑 AND 层过多 → 去一层；再看同义词是否太窄（补缩写/单复数/连字符变体/通配符）；再看体系词是否过度限定；最后才放宽字段。
- `too-wide`（N>300）：补一层最小的 AND（材料/方法/性能任选最贴题的）；把裸词换成带引号短语；把 Topic 收紧成 TI+AB 或 Title；或加一层 NOT 排除最大的一坨跑偏主题。

## 轮次上限

默认 3 轮（`gate.maxAttempts`）。到了上限仍未进区间：**把历次 N 值与式子整表摆给用户**，让他二选一——
继续修订（`wos_query_revise` 带 `userDecided: true`），或明确豁免闸门（`wos_import_records` 带
`acceptOutOfRange: true` + `acceptReason`）。豁免会写进账本与 records.md，不是静默放过。

## 导出设置（每次都要手改）

Plain text file、Record Content = **Full Record**、Records from `1` to `N`（单次上限 1000）。
缺 DOI 是 WOS 元数据局限，账本里保留 `no DOI`，不要留空、不要编造。
