/**
 * 下载阶段：分组计划、PDF 收编与磁盘审计。
 *
 * 这一层存在的原因：手写文件名是这条流水线历史上最贵的事故来源
 * （文件名凭摘要臆测，把纪念文集写成了「in situ TEM 疲劳」）。
 * 所以文件名只由 `canonicalPdfName(record)` 生成，收编时强制验 `%PDF-`，
 * HTML 壳、过小文件、跨篇错配一律判 fail 并留原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalPdfName } from './savedrecs.js';
import { RunError, inGradients, runPaths, LEVEL_TO_GRADIENT } from './run.js';

/** 出版商识别：先按 WOS `PU` 字段文本匹配，再退回 DOI 前缀。 */
const PUBLISHER_RULES = [
  { test: /elsevier/i, key: 'Elsevier', pdfHint: '文章页取 View PDF 的 pdfft 直链后导航（inline 响应常不落盘，注意区分）' },
  { test: /mdpi/i, key: 'MDPI', pdfHint: 'https://www.mdpi.com/<ISSN>/<vol>/<issue>/<id>/pdf（attachment，navigate 即下载）' },
  { test: /springer|nature portfolio/i, key: 'Springer', pdfHint: 'https://link.springer.com/content/pdf/<DOI>.pdf；302 回文章页即无订阅' },
  { test: /wiley/i, key: 'Wiley', pdfHint: 'https://<sub>.onlinelibrary.wiley.com/doi/pdfdirect/<DOI>（/doi/pdf/ 会超时）' },
  { test: /amer chemical|american chemical/i, key: 'ACS', pdfHint: '文章页 Open PDF 的 article-pdf 直链' },
  { test: /amer physical|american physical/i, key: 'APS', pdfHint: 'https://journals.aps.org/<journal>/pdf/<DOI>' },
  { test: /royal soc|royal chemical/i, key: 'RSC', pdfHint: '主格式超时就降级 https://pubs.rsc.org/en/content/articlepdf/<YEAR>/<journal>/<ID>' },
  { test: /institute of physics|iop/i, key: 'IOP', pdfHint: 'https://iopscience.iop.org/article/<DOI>/pdf' },
  { test: /frontiers/i, key: 'Frontiers', pdfHint: 'https://www.frontiersin.org/journals/<journal>/articles/<DOI>/pdf' },
  { test: /asme|mechanical engineers/i, key: 'ASME', pdfHint: '多数无机构权限，直接判 fail 省时间' },
  { test: /emerald/i, key: 'Emerald', pdfHint: '多数只有 Buy This Article，直接判 fail' },
  { test: /trans tech|scientific\.net/i, key: 'TransTech', pdfHint: '付费墙，直接判 fail' },
  { test: /taylor|informa/i, key: 'TaylorFrancis', pdfHint: '文章页 PDF 链接' },
  { test: /^sage|sage publications/i, key: 'SAGE', pdfHint: '文章页 PDF 链接' },
  { test: /american institute of physics/i, key: 'AIP', pdfHint: '文章页 PDF 链接' },
  { test: /ieee/i, key: 'IEEE', pdfHint: '文章页 PDF 链接' },
  { test: /chinese|beijing|zhongguo/i, key: 'CN-Journal', pdfHint: '中文刊 DOI 常失效（DOI Cannot Connect to Server），优先 J-STAGE / 期刊官网' },
];

const DOI_PREFIX_RULES = [
  ['10.1016', 'Elsevier'],
  ['10.3390', 'MDPI'],
  ['10.1007', 'Springer'],
  ['10.1038', 'Springer'],
  ['10.1002', 'Wiley'],
  ['10.1111', 'Wiley'],
  ['10.1021', 'ACS'],
  ['10.1103', 'APS'],
  ['10.1039', 'RSC'],
  ['10.1088', 'IOP'],
  ['10.3389', 'Frontiers'],
  ['10.1115', 'ASME'],
  ['10.1108', 'Emerald'],
  ['10.4028', 'TransTech'],
  ['10.1080', 'TaylorFrancis'],
  ['10.1177', 'SAGE'],
  ['10.1063', 'AIP'],
  ['10.1109', 'IEEE'],
  ['10.1149', 'ECS'],
  ['10.2320', 'J-STAGE'],
  ['10.11900', 'CN-Journal'],
  ['10.12442', 'CN-Journal'],
];

const HINTS = new Map(PUBLISHER_RULES.map((rule) => [rule.key, rule.pdfHint]));

/** 记录所属出版商（供分组集中下载）。 */
export function publisherOf(record) {
  const raw = String(record.publisher ?? '');
  for (const rule of PUBLISHER_RULES) {
    if (raw && rule.test.test(raw)) return rule.key;
  }
  const doi = String(record.doi ?? '');
  for (const [prefix, key] of DOI_PREFIX_RULES) {
    if (doi.toLowerCase().startsWith(prefix)) return key;
  }
  if (raw) return raw.trim();
  return 'Unknown';
}

export function pdfHintOf(key) {
  return HINTS.get(key) ?? '打开 https://doi.org/<DOI> 在文章页找 PDF 直链';
}

/**
 * 按梯度 + 出版商分组给出下载清单。
 * 同一出版商的会话级校验只需过一次，集中打一家能显著降低失败率。
 */
export function downloadPlan(run, { gradient, groupBy = 'publisher', limit = 50 } = {}) {
  const wanted = new Set(gradient ? [gradient] : run.gradients.selected);
  const queue = run.records.filter(
    (record) => inGradients(run, record) && record.download.status !== 'ok' && wanted.has(LEVEL_TO_GRADIENT[record.level]),
  );

  const groups = new Map();
  for (const record of queue) {
    const key = groupBy === 'journal' ? record.j9 || record.journal || 'Unknown' : publisherOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const out = [...groups.entries()]
    .map(([key, records]) => ({
      key,
      count: records.length,
      pdfHint: groupBy === 'journal' ? '按期刊集中下载' : pdfHintOf(key),
      records: records.slice(0, limit).map((record) => ({
        n: record.n,
        level: record.level,
        doi: record.doi,
        doiUrl: record.doi ? `https://doi.org/${record.doi}` : null,
        suggestedName: canonicalPdfName(record),
        journal: record.j9 || record.journal,
        year: record.year,
        state: record.download.status,
      })),
      omitted: Math.max(records.length - limit, 0),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    runId: run.runId,
    gradients: [...wanted],
    groupBy,
    total: queue.length,
    noDoi: queue.filter((record) => !record.doi).length,
    groups: out,
  };
}

const LEVEL_GRADIENT = LEVEL_TO_GRADIENT;

/** 只读首字节判断是不是真 PDF。 */
export function pdfMagicOk(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    const buffer = Buffer.alloc(8);
    const read = fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);
    return read >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  } catch {
    return false;
  }
}

function pickTargetName(record, downloadsDir) {
  const base = canonicalPdfName(record);
  if (!fs.existsSync(path.join(downloadsDir, base))) return base;
  const second = (record.authorsShort ?? [])[1];
  if (second) {
    const surname = String(second).split(/[ ,]/)[0].replace(/[^A-Za-z0-9]/g, '');
    if (surname) {
      const candidate = base.replace(/\.pdf$/i, `_${surname}.pdf`);
      if (!fs.existsSync(path.join(downloadsDir, candidate))) return candidate;
    }
  }
  for (let index = 2; index < 50; index += 1) {
    const candidate = base.replace(/\.pdf$/i, `_${index}.pdf`);
    if (!fs.existsSync(path.join(downloadsDir, candidate))) return candidate;
  }
  throw new RunError('NAME_EXHAUSTED', `无法为记录 ${record.n} 找到不冲突的文件名`);
}

/**
 * 移走文件。返回 `{ leftover }`：`leftover=true` 表示**目标已就位但源文件删不掉**
 * （Chrome 还在写、杀软/OneDrive 锁句柄，实测 EBUSY）。这种情况必须当成功处理，
 * 只是提醒收尾时清残留——不能因为删不掉源文件就把已下好的 PDF 判成失败。
 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
    return { leftover: false };
  } catch {
    fs.copyFileSync(from, to);
    try {
      fs.unlinkSync(from);
      return { leftover: false };
    } catch {
      return { leftover: true };
    }
  }
}

/**
 * 收编一个已落盘的 PDF：验头 → 按规范改名 → 移入 downloads/ → 标记 ok。
 * 失败也写账本（status=fail + 原因），不让坏文件静默占位。
 */
export function intakePdf(run, { n, sourcePath }) {
  const record = run.records.find((item) => item.n === n);
  if (!record) throw new RunError('PATCH_UNKNOWN_RECORD', `账本里没有第 ${n} 条记录（共 ${run.records.length} 条）`);
  const from = path.resolve(String(sourcePath ?? ''));
  if (!sourcePath || !fs.existsSync(from)) {
    throw new RunError('INTAKE_FILE_MISSING', `找不到要收编的文件：${from}`);
  }
  const paths = runPaths(run.dir);
  fs.mkdirSync(paths.downloads, { recursive: true });

  const size = fs.statSync(from).size;
  const magic = pdfMagicOk(from);
  let failReason = null;
  if (!magic) failReason = 'HTML 壳：首字节不是 %PDF-（出版社返回了网页，不是 PDF）';
  else if (size < 20000) failReason = `文件过小（${size} B），疑似错误页而不是论文`;

  if (failReason) {
    record.download = { status: 'fail', file: null, failReason };
    return { ok: false, n, from, size, reason: failReason, record: { n, title: record.title } };
  }

  const name = pickTargetName(record, paths.downloads);
  const to = path.join(paths.downloads, name);
  const moved = moveFile(from, to);
  if (!pdfMagicOk(to)) {
    record.download = { status: 'fail', file: null, failReason: '移动后校验失败：目标文件不是合法 PDF' };
    return { ok: false, n, from, to, size, reason: '移动后校验失败', record: { n, title: record.title } };
  }

  record.download = { status: 'ok', file: name, failReason: null };
  return {
    ok: true,
    n,
    from,
    to,
    file: name,
    size,
    leftoverSource: moved.leftover,
    hint: moved.leftover ? '源文件被占用未能删除（EBUSY）：已收编成功，收尾时把 Downloads 里的同名残留隔离掉' : undefined,
    record: { n, title: record.title, doi: record.doi },
  };
}

/** 文件名实义词与 WOS 标题的重合度：只用来缩小人工复核范围，不作自动判错。 */
export function nameTitleOverlap(fileName, title) {
  const stem = String(fileName ?? '').replace(/\.pdf$/i, '').split('_').slice(3).join('_');
  const tokens = stem.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 2).map((word) => word.toLowerCase());
  if (tokens.length === 0) return { tokens: 0, matched: 0, ratio: 0 };
  const haystack = String(title ?? '').toLowerCase();
  const matched = tokens.filter((word) => haystack.includes(word)).length;
  return { tokens: tokens.length, matched, ratio: matched / tokens.length };
}

/**
 * 下载收尾审计：全库验 %PDF-、与 ✅ 行数对账、把无主文件隔离到 _quarantine/。
 */
export function auditDownloads(run, { quarantine = false } = {}) {
  const paths = runPaths(run.dir);
  const files = fs.existsSync(paths.downloads)
    ? fs.readdirSync(paths.downloads, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
        .map((entry) => entry.name)
    : [];

  const markedOk = run.records.filter((record) => record.download.status === 'ok');
  const missing = [];
  const corrupt = [];
  const suspicious = [];

  for (const record of markedOk) {
    const file = record.download.file;
    if (!file || !files.includes(file)) {
      missing.push({ n: record.n, file });
      continue;
    }
    const abs = path.join(paths.downloads, file);
    if (!pdfMagicOk(abs)) {
      corrupt.push({ n: record.n, file, reason: '首字节不是 %PDF-' });
      continue;
    }
    const overlap = nameTitleOverlap(file, record.title);
    if (overlap.tokens >= 2 && overlap.ratio < 0.34) {
      suspicious.push({ n: record.n, file, ratio: Number(overlap.ratio.toFixed(2)), note: '文件名实义词与标题低重合，回摘要/全文复核，不等于错误' });
    }
  }

  const unaccounted = files.filter((file) => !markedOk.some((record) => record.download.file === file));
  const quarantined = [];
  if (quarantine && unaccounted.length > 0) {
    fs.mkdirSync(paths.quarantine, { recursive: true });
    for (const file of unaccounted) {
      moveFile(path.join(paths.downloads, file), path.join(paths.quarantine, file));
      quarantined.push(file);
    }
  }

  return {
    pdfFiles: files.length,
    markedOk: markedOk.length,
    consistent: missing.length === 0 && corrupt.length === 0 && (unaccounted.length === 0 || quarantined.length === unaccounted.length),
    missing,
    corrupt,
    unaccounted,
    quarantined,
    suspicious,
    quarantineDir: paths.quarantine,
  };
}
