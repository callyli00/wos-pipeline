/**
 * 知识库阶段：建库的机械能力（骨架 / raw 落位 / 五层 lint / index 重生）。
 *
 * 移植的是「可判定」的部分——骨架、raw 落位与 frontmatter、五层扫描 lint、
 * index 重生与 BUILD_REPORT。页面内容仍然由模型读全文后撰写：那需要理解与取舍，
 * 写成固定代码只会产出看似整齐的空壳。
 *
 * 硬规则（每条都来自实战事故）：
 *  - raw/ 只读：落位后不再修改，纠错写 wiki 页。
 *  - index 生成器必须覆盖**全部**内容层：写死层列表会让新增层静默丢失。
 *  - 统计 sources 用引号串计数，不按逗号切。
 *  - frontmatter 标量用 JSON 序列化（yaml.safe_dump 会带 `...` 截断文档）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 内容层。新增层只需加到这里，index / lint / 报告都会自动覆盖。 */
export const LAYERS = ['papers', 'entities', 'concepts', 'comparisons', 'queries'];

const PAGE_TYPES = new Set(['paper', 'entity', 'concept', 'comparison', 'query', 'summary']);

const REQUIRED_FIELDS = ['title', 'created', 'updated', 'type', 'tags', 'sources'];

const DEFAULT_TAGS = [
  'paper',
  'person',
  'organization',
  'method',
  'synthesis',
  'characterization',
  'self-assembly',
  'evaporation',
  'nanoparticle',
  'mesoporous',
  'thin-film',
  'colloid',
  'review',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfAbsent(file, content) {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

/** frontmatter 里带引号的串数条目：不能按逗号切。 */
export function countQuotedSources(frontmatterText) {
  const line = String(frontmatterText).match(/^sources:\s*(.+)$/m);
  if (!line) return 0;
  const quoted = line[1].match(/"[^"]+"/g);
  if (quoted) return quoted.length;
  const bracket = line[1].match(/\[(.*)\]/);
  if (bracket) return bracket[1].split(',').map((item) => item.trim()).filter(Boolean).length;
  return line[1].trim() ? 1 : 0;
}

/** 极简 frontmatter 解析：够用即可，不引第三方 YAML。 */
export function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: String(text), raw: '' };
  const raw = match[1];
  const data = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1];
    const value = kv[2].trim();
    if (value === '') {
      data[currentKey] = [];
    } else if (value.startsWith('[')) {
      const inner = value.replace(/^\[|\]$/g, '');
      data[currentKey] = inner
        .split(',')
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
    } else {
      data[currentKey] = unquote(value);
    }
  }
  return { data, body: String(text).slice(match[0].length), raw };
}

function unquote(value) {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/** 标量用 JSON 序列化：合法 YAML，且不会像 safe_dump 那样追加 `...` 截断文档。 */
function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function yamlList(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(', ')}]`;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);
}

function pageSlug(fileName) {
  return fileName.replace(/\.md$/i, '').toLowerCase();
}

function extractLinks(body) {
  const links = [];
  const pattern = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let hit = pattern.exec(body);
  while (hit) {
    links.push(hit[1].trim().toLowerCase().replace(/\s+/g, '-'));
    hit = pattern.exec(body);
  }
  return [...new Set(links)];
}

/** SCHEMA 里的标签白名单：读 `## Tag Taxonomy` 下第一个代码块里的 `- tag`。 */
export function readTaxonomy(schemaText) {
  const section = String(schemaText).split(/^##\s+Tag Taxonomy\s*$/m)[1];
  if (!section) return [];
  const block = section.match(/```[a-z]*\s*\n([\s\S]*?)```/);
  const source = block ? block[1] : section;
  const tags = [];
  for (const line of source.split(/\r?\n/)) {
    const hit = line.match(/^\s*-\s+([a-z0-9][a-z0-9-]*)\s*$/i);
    if (hit) tags.push(hit[1].toLowerCase());
  }
  return [...new Set(tags)];
}

function appendLog(wikiRoot, action, subject, lines) {
  const file = path.join(wikiRoot, 'log.md');
  const entry = [`## [${today()}] ${action} | ${subject}`, ...(lines ?? []).map((line) => `- ${line}`), ''].join('\n');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Wiki Log\n\n> Append-only.\n\n${entry}`, 'utf8');
    return;
  }
  fs.appendFileSync(file, `${entry}\n`, 'utf8');
}

const SCHEMA_TEMPLATE = (topic, domain, tags) => `# Wiki Schema

## Domain
${domain || `围绕「${topic}」的文献知识库：材料体系、组装机理、结构与性能、表征方法。`}

## Conventions
- 文件名小写、连字符、无空格（如 \`evaporation-induced-self-assembly.md\`）
- 每个 wiki 页以 YAML frontmatter 开头（字段见下）
- 页间用 \`[[wikilinks]]\` 互链，**每页至少 2 条出站链接**
- 更新页面必须同步 \`updated\` 日期
- 新页必须登记进 \`index.md\` 的对应层
- 每次动作追加到 \`log.md\`
- 综合 3 个以上来源的页面，在段末加 \`^[raw/papers/xxx/full.md]\` 溯源标记
- 中文叙述 + 英文术语/标签；标签全小写连字符

## Frontmatter

\`\`\`yaml
---
title: "页面标题"
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: paper | entity | concept | comparison | query
tags: [paper, self-assembly]
sources: ["raw/papers/001_Journal_2024_Title/full.md"]
summary: "一句话摘要，供 index 使用"
confidence: high | medium | low
contested: false
---
\`\`\`

> \`sources\` 必须是**带引号的列表**：目录名里常有逗号（如 \`Fe,Co,Ni\`），
> 不加引号会把一个源切成两个，统计全错。

### raw/ frontmatter

\`\`\`yaml
---
source_url: https://doi.org/10.xxxx/xxxxx
ingested: YYYY-MM-DD
sha256: <正文（frontmatter 之后的部分）的 sha256>
---
\`\`\`

## Tag Taxonomy

先登记再使用；新增标签必须写进下面这个代码块。

\`\`\`yaml tags
${tags.map((tag) => `- ${tag}`).join('\n')}
\`\`\`

## Page Thresholds
- **建页**：实体/概念出现在 2 个以上来源，或对单个来源是核心
- **并入已有页**：来源提到的内容已被覆盖
- **不建页**：顺带一提、细节、领域外内容
- **拆页**：超过约 200 行
- **归档**：内容被完全取代 → 移入 \`_archive/\` 并从 index 移除

## Entity / Concept / Comparison 页要点
- Entity（人物/机构）：概览、关键事实与年份、关系（\`[[wikilinks]]\`）、来源
- Concept：定义、当前认识、开放问题、相关概念
- Comparison：比较对象与理由、比较维度（表格）、结论、来源

## Update Policy
1. 先看日期：新来源一般覆盖旧来源
2. 真冲突就双立场并记（带日期与来源）
3. frontmatter 标 \`contradictions: [page-slug]\`
4. lint 报告里提交用户复核
`;

const INDEX_TEMPLATE = (topic) => `# Wiki Index

> 内容目录。每页一行：wikilink + 一句话摘要。
> 先读这里再决定读哪些页。
> Last updated: ${today()} | Total pages: 0

${LAYERS.map((layer) => `## ${layer}\n`).join('\n')}`;

const PROCESS_TEMPLATE = (topic) => `# 处理台账 — ${topic}

> 每篇文献一行。状态：🔲 未开始 / 🔄 进行中 / ✅ 完成 / ⚠️ 有问题。
> 跨会话恢复靠这张表。

| # | 标题 | raw 目录 | paper 页 | 状态 |
| --- | --- | --- | --- | --- |
`;

/** 建骨架。已存在则不覆盖，只补缺的目录。 */
export function wikiInit({ wikiRoot, topic, domain, tags, records }) {
  const root = path.resolve(wikiRoot);
  ensureDir(root);
  for (const layer of LAYERS) ensureDir(path.join(root, layer));
  for (const extra of ['raw/papers', 'raw/assets', '_meta', '_archive']) ensureDir(path.join(root, extra));

  const taxonomy = tags && tags.length > 0 ? tags.map((tag) => slugify(tag)) : DEFAULT_TAGS;
  const created = [];
  if (writeIfAbsent(path.join(root, 'SCHEMA.md'), SCHEMA_TEMPLATE(topic, domain, taxonomy))) created.push('SCHEMA.md');
  if (writeIfAbsent(path.join(root, 'index.md'), INDEX_TEMPLATE(topic))) created.push('index.md');
  if (writeIfAbsent(path.join(root, 'log.md'), `# Wiki Log\n\n> Append-only.\n\n## [${today()}] create | Wiki 初始化\n- 主题：${topic}\n- 目录：${LAYERS.join(' / ')} + raw/ + _meta/ + _archive/\n`)) created.push('log.md');
  if (writeIfAbsent(path.join(root, 'papers', 'README.md'), `# Papers 目录\n\n> 自动目录，**不是 wiki 页**：不要在这里加双方括号链接，否则会污染图谱。\n\n| # | 标题 | 页 |\n| --- | --- | --- |\n`)) created.push('papers/README.md');

  const processFile = path.join(root, '_meta', 'PROCESS.md');
  if (!fs.existsSync(processFile)) {
    const rows = (records ?? []).map((record) => {
      const slug = record.wiki?.rawDir ? path.basename(record.wiki.rawDir) : `${String(record.n).padStart(3, '0')}_pending`;
      return `| ${record.n} | ${String(record.title ?? '').replace(/\|/g, '\\|').slice(0, 90)} | raw/papers/${slug} | 🔲 | 🔲 |`;
    });
    fs.writeFileSync(processFile, `${PROCESS_TEMPLATE(topic)}${rows.join('\n')}\n`, 'utf8');
    created.push('_meta/PROCESS.md');
  }

  appendLog(root, 'create', 'wiki 骨架', [`路径：${root}`, `新建：${created.join(', ') || '（已存在，无新增）'}`]);
  return { wikiRoot: root, created, layers: LAYERS, tags: taxonomy };
}

function rawFrontmatter(record, bodySha) {
  const lines = ['---'];
  if (record.doi) lines.push(`source_url: ${yamlScalar(`https://doi.org/${record.doi}`)}`);
  lines.push(`ingested: ${today()}`);
  lines.push(`sha256: ${bodySha}`);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * 把已解析的全文落到 raw/papers/，并补 raw frontmatter。
 * 同源重跑按 sha256 判等：一致跳过，不一致报 drift（不静默覆盖）。
 */
export function stageRaw({ wikiRoot, run }) {
  const root = path.resolve(wikiRoot);
  ensureDir(path.join(root, 'raw', 'papers'));
  const staged = [];
  const skipped = [];
  const drift = [];
  const missing = [];

  for (const record of run.records) {
    if (record.parse.status !== 'ok' || !record.parse.fullMd) continue;
    const srcFull = path.resolve(run.dir, record.parse.fullMd);
    if (!fs.existsSync(srcFull)) {
      missing.push({ n: record.n, expected: record.parse.fullMd });
      continue;
    }
    const stem = String(record.download.file ?? '').replace(/\.pdf$/i, '') || `${String(record.n).padStart(3, '0')}`;
    const destDir = path.join(root, 'raw', 'papers', stem);
    ensureDir(destDir);
    const destFull = path.join(destDir, 'full.md');

    const rawText = fs.readFileSync(srcFull, 'utf8');
    const parsed = parseFrontmatter(rawText);
    const body = parsed.body;
    const bodySha = sha256(body);

    if (fs.existsSync(destFull)) {
      const existing = parseFrontmatter(fs.readFileSync(destFull, 'utf8'));
      const existingSha = sha256(existing.body);
      if (existingSha === bodySha) {
        skipped.push({ n: record.n, rawDir: path.relative(root, destDir).replace(/\\/g, '/') });
        record.wiki = { ...(record.wiki ?? {}), rawDir: path.relative(root, destDir).replace(/\\/g, '/') };
        continue;
      }
      drift.push({ n: record.n, oldSha: existingSha.slice(0, 12), newSha: bodySha.slice(0, 12) });
    }

    // 同目录的图片与 sidecar 一并复制（溯源零成本）
    for (const entry of fs.readdirSync(path.dirname(srcFull), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.cpSync(path.join(path.dirname(srcFull), entry.name), path.join(destDir, entry.name), { recursive: true });
      } else if (entry.name.toLowerCase() !== 'full.md' && entry.name.toLowerCase() !== 'markdown.md') {
        fs.copyFileSync(path.join(path.dirname(srcFull), entry.name), path.join(destDir, entry.name));
      }
    }

    fs.writeFileSync(destFull, `${rawFrontmatter(record, bodySha)}${body}`, 'utf8');
    const rel = path.relative(root, destDir).replace(/\\/g, '/');
    record.wiki = { ...(record.wiki ?? {}), rawDir: rel };
    staged.push({ n: record.n, rawDir: rel, sha256: bodySha.slice(0, 12), bytes: body.length });
  }

  if (staged.length > 0 || drift.length > 0) {
    appendLog(root, 'ingest', `raw 落位 ${staged.length} 篇`, [
      `新增/更新：${staged.map((item) => item.n).join(', ') || '无'}`,
      `跳过（同 sha256）：${skipped.length}`,
      `漂移待复核：${drift.map((item) => item.n).join(', ') || '无'}`,
    ]);
  }

  return {
    wikiRoot: root,
    staged: staged.length,
    skipped: skipped.length,
    drift,
    missing,
    items: staged.slice(0, 50),
    omitted: Math.max(staged.length - 50, 0),
  };
}

function summarize(body) {
  const text = String(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('>'));
  return (text ?? '').slice(0, 120);
}

/** 全库扫描 + 体检。 */
export function wikiLint({ wikiRoot }) {
  const root = path.resolve(wikiRoot);
  const schemaFile = path.join(root, 'SCHEMA.md');
  if (!fs.existsSync(schemaFile)) {
    throw new Error(`不是 wiki 目录（缺 SCHEMA.md）：${root}`);
  }
  const taxonomy = readTaxonomy(fs.readFileSync(schemaFile, 'utf8'));
  const taxonomySet = new Set(taxonomy);

  const pages = [];
  const layerCounts = {};
  for (const layer of LAYERS) {
    const files = listFiles(path.join(root, layer)).filter((name) => !(layer === 'papers' && name.toLowerCase() === 'readme.md'));
    layerCounts[layer] = files.length;
    for (const fileName of files) {
      const abs = path.join(root, layer, fileName);
      const text = fs.readFileSync(abs, 'utf8');
      const parsed = parseFrontmatter(text);
      pages.push({
        layer,
        fileName,
        abs,
        rel: path.relative(root, abs).replace(/\\/g, '/'),
        slug: pageSlug(fileName),
        data: parsed.data,
        body: parsed.body,
        lines: text.split(/\r?\n/).length,
        links: extractLinks(parsed.body),
        sourcesCount: countQuotedSources(parsed.raw),
      });
    }
  }

  const slugSet = new Set(pages.map((page) => page.slug));
  const inbound = new Map(pages.map((page) => [page.slug, 0]));
  const broken = [];
  for (const page of pages) {
    for (const link of page.links) {
      if (!slugSet.has(link)) {
        broken.push({ page: page.rel, link });
      } else if (link !== page.slug) {
        inbound.set(link, (inbound.get(link) ?? 0) + 1);
      }
    }
  }

  const missingFields = [];
  const badTags = [];
  const tooFewLinks = [];
  const badType = [];
  const noSources = [];
  const oversized = [];
  const contested = [];
  const lowConfidence = [];

  for (const page of pages) {
    const absent = REQUIRED_FIELDS.filter((field) => {
      const value = page.data[field];
      if (Array.isArray(value)) return value.length === 0;
      return value === undefined || value === '';
    });
    if (absent.length > 0) missingFields.push({ page: page.rel, absent });

    const tags = Array.isArray(page.data.tags) ? page.data.tags : page.data.tags ? [page.data.tags] : [];
    const unknown = tags.filter((tag) => !taxonomySet.has(String(tag).toLowerCase()));
    if (unknown.length > 0) badTags.push({ page: page.rel, unknown });

    if (page.data.type && !PAGE_TYPES.has(String(page.data.type))) {
      badType.push({ page: page.rel, type: page.data.type });
    }
    if (page.links.length < 2) tooFewLinks.push({ page: page.rel, links: page.links.length });
    if (page.sourcesCount === 0) noSources.push(page.rel);
    if (page.lines > 200) oversized.push({ page: page.rel, lines: page.lines });
    if (String(page.data.contested) === 'true') contested.push(page.rel);
    if (String(page.data.confidence) === 'low') lowConfidence.push(page.rel);
  }

  const orphans = pages
    .filter((page) => (inbound.get(page.slug) ?? 0) === 0)
    .map((page) => page.rel);

  const indexFile = path.join(root, 'index.md');
  const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const missingInIndex = pages.filter((page) => !indexText.toLowerCase().includes(page.slug)).map((page) => page.rel);

  // raw 漂移：raw/ 不可变，哈希变了说明被改过
  const rawDrift = [];
  const rawPapers = path.join(root, 'raw', 'papers');
  if (fs.existsSync(rawPapers)) {
    for (const entry of fs.readdirSync(rawPapers, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullMd = path.join(rawPapers, entry.name, 'full.md');
      if (!fs.existsSync(fullMd)) continue;
      const parsed = parseFrontmatter(fs.readFileSync(fullMd, 'utf8'));
      const stored = String(parsed.data.sha256 ?? '');
      if (!stored) continue;
      const actual = sha256(parsed.body);
      if (actual !== stored) rawDrift.push({ rawDir: `raw/papers/${entry.name}`, stored: stored.slice(0, 12), actual: actual.slice(0, 12) });
    }
  }

  const logFile = path.join(root, 'log.md');
  const logEntries = fs.existsSync(logFile) ? (fs.readFileSync(logFile, 'utf8').match(/^## \[/gm) ?? []).length : 0;

  const scanned = pages.length;
  const summed = Object.values(layerCounts).reduce((sum, value) => sum + value, 0);

  return {
    wikiRoot: root,
    pages: scanned,
    layerCounts,
    coverageConsistent: scanned === summed,
    issues: {
      brokenLinks: broken,
      orphans,
      missingInIndex,
      missingFields,
      badTags,
      badType,
      tooFewLinks,
      noSources,
      oversized,
      contested,
      lowConfidence,
      rawDrift,
    },
    logEntries,
    logRotationNeeded: logEntries > 500,
    verdict: broken.length === 0 && missingInIndex.length === 0 && missingFields.length === 0 && badTags.length === 0 ? 'healthy' : 'needs-work',
  };
}

/** 重生成 index.md 与 BUILD_REPORT。层列表来自 LAYERS，不写死。 */
export function wikiIndex({ wikiRoot, topic }) {
  const root = path.resolve(wikiRoot);
  const schemaFile = path.join(root, 'SCHEMA.md');
  if (!fs.existsSync(schemaFile)) throw new Error(`不是 wiki 目录（缺 SCHEMA.md）：${root}`);

  const sections = [];
  const report = [];
  let total = 0;

  for (const layer of LAYERS) {
    const files = listFiles(path.join(root, layer))
      .filter((name) => !(layer === 'papers' && name.toLowerCase() === 'readme.md'))
      .sort();
    const rows = [];
    for (const fileName of files) {
      const text = fs.readFileSync(path.join(root, layer, fileName), 'utf8');
      const parsed = parseFrontmatter(text);
      const title = parsed.data.title || fileName.replace(/\.md$/i, '');
      const summary = parsed.data.summary || summarize(parsed.body);
      rows.push(`- [[${fileName.replace(/\.md$/i, '')}]] — ${summary || '（无摘要）'}`);
    }
    total += files.length;
    report.push({ layer, count: files.length });
    sections.push(`## ${layer}\n\n${rows.length > 0 ? rows.join('\n') : '_（本层暂无页面）_'}\n`);
  }

  const header = `# Wiki Index\n\n> 内容目录。每页一行：wikilink + 一句话摘要。\n> 先读这里再决定读哪些页。\n> Last updated: ${today()} | Total pages: ${total}\n`;
  fs.writeFileSync(path.join(root, 'index.md'), `${header}\n${sections.join('\n')}`, 'utf8');

  const summed = report.reduce((sum, item) => sum + item.count, 0);
  const buildReport = [
    `# BUILD REPORT — ${topic || path.basename(root)}`,
    '',
    `生成时间：${new Date().toISOString()}`,
    `扫描层：${LAYERS.join(', ')}`,
    `总页数：${total}`,
    '',
    '| 层 | 页数 |',
    '| --- | --- |',
    ...report.map((item) => `| ${item.layer} | ${item.count} |`),
    '',
    `扫描总数 == 分层求和：${total === summed ? '✅' : `❌（${total} vs ${summed}，有层未被扫到）`}`,
    '',
  ].join('\n');
  ensureDir(path.join(root, '_meta'));
  fs.writeFileSync(path.join(root, '_meta', 'BUILD_REPORT.md'), buildReport, 'utf8');

  appendLog(root, 'update', 'index 重生成', [`总页数：${total}`, ...report.map((item) => `${item.layer}: ${item.count}`)]);

  return { wikiRoot: root, total, layers: report, consistent: total === summed, indexFile: path.join(root, 'index.md') };
}
