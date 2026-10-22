# 阶段 downloaded：收编与审计口径

每篇 PDF 落盘后**立刻收编**，不要攒到最后一起改——攒批是错配的温床。

## 收编（`wos_pdf_intake`）

1. 先 `wos_pdf_intake({ n, sourcePath: <下载目录> })` 给目录：只列候选，不收编。看时间戳与大小挑出属于该记录的那个。
2. 再 `wos_pdf_intake({ n, sourcePath: <具体文件> })` 完成收编：验 `%PDF-` → 按规范改名 → 移入 `downloads/` → 标记 ok。
3. 文件名**只由 WOS 的 TI/J9/PY 生成**，不接受手写。历史上最贵的事故就是「凭摘要臆测文件名」，把一篇纪念文集写成了不存在的研究论文。

## 失败分类（直接判 fail，别硬试）

| 现象 | 判据 | 处置 |
| --- | --- | --- |
| HTML 壳 | 首字节不是 `%PDF-` | 判 fail，回文章页找真直链；RSC CDN / ScienceDirect 惯犯 |
| 文件过小 | < 20 KB | 判 fail，多半是错误页 |
| 无 PDF 按钮 | 只有 Buy This Article / Read The Paper | 判 fail（Emerald / TransTech / ASME 常见），不要反复换 UA |
| DOI 失效 | 页面标题 `Error: DOI Cannot Connect to Server` | 判 fail 并标「待人工」（中文刊 10.11900 / 10.12442 常见） |
| 无权限 | `Subscribe and save` 且无任何 PDF 链接 | 判 fail；同篇换网可能有权限，别在同一网络死磕 |

## 审计（`wos_download_audit`）

- 收尾跑一次：全库逐文件验 `%PDF-`，与账本 ✅ 行数对账。
- `unaccounted`（无主文件）先看再决定，`quarantine: true` 会移进 `_quarantine/`——**隔离优于删除**，曾有被判废件的文件事后证明是真件。
- `suspicious` 是「文件名实义词与标题低重合」，只用来缩小人工复核范围：实测 9 个低重合里 8 个是内容描述式命名、仅 1 个真错。**必须回摘要/全文判定，不得自动判错。**

## 页面状态只看结构

Cloudflare / hCaptcha 从 `dialog` / `Iframe` 节点识别，不用 `screenshot`、不靠看图下结论。
