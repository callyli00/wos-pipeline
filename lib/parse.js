/**
 * 解析阶段：把 PDF → Markdown 的活儿交给已装的 dsh-pdf-mineru 插件，
 * 本模块只负责「该解析哪些、产物该落在哪、怎么回填账本」。
 *
 * 不复刻 MinerU 客户端：那会变成两套实现、两个 token 配置、两处漂移。
 */

import fs from 'node:fs';
import path from 'node:path';
import { runPaths, LEVEL_TO_GRADIENT } from './run.js';

/** 解析产物的候选文件名（不同 provider/版本落盘名不同）。 */
const FULL_MD_CANDIDATES = ['full.md', 'markdown.md', 'index.md'];

function pdfAbs(run, record) {
  if (!record.download.file) return null;
  return path.join(runPaths(run.dir).downloads, record.download.file);
}

function stemOf(record) {
  return String(record.download.file ?? '').replace(/\.pdf$/i, '');
}

/**
 * 待解析清单。每条给出可直接照抄的两步调用：
 *  ① async_parse_pdf 解析  ② read_pdf(focus:"artifacts") 取产物路径
 * 产物统一复制到 `downloads/<PDF 主名>/full.md`，与 PDF 同名同目录，溯源零成本。
 */
export function parsePlan(run, { gradient, limit = 40 } = {}) {
  const wanted = gradient ? new Set([gradient]) : new Set(run.gradients.selected);
  const queue = run.records.filter(
    (record) =>
      record.download.status === 'ok' &&
      record.parse.status !== 'ok' &&
      (wanted.size === 0 || wanted.has(LEVEL_TO_GRADIENT[record.level])),
  );

  const items = queue.slice(0, limit).map((record) => {
    const abs = pdfAbs(run, record);
    const stem = stemOf(record);
    return {
      n: record.n,
      level: record.level,
      title: record.title,
      pdf: abs,
      pdfExists: Boolean(abs && fs.existsSync(abs)),
      targetDir: path.join(runPaths(run.dir).downloads, stem),
      targetFullMd: path.join(runPaths(run.dir).downloads, stem, 'full.md'),
      steps: [
        { tool: 'async_parse_pdf', args: { file_path: abs } },
        { tool: 'read_pdf', args: { file_path: abs, focus: 'artifacts' } },
        { tool: 'wos_parse_audit', args: { runId: run.runId, apply: true } },
      ],
    };
  });

  return {
    runId: run.runId,
    gradients: [...wanted],
    total: queue.length,
    returned: items.length,
    omitted: Math.max(queue.length - items.length, 0),
    convention: '产物复制到 downloads/<PDF 主名>/full.md；没有 full.md 视为未解析',
    items,
  };
}

function findFullMd(run, record) {
  const downloads = runPaths(run.dir).downloads;
  const stem = stemOf(record);
  const candidates = [];
  for (const name of FULL_MD_CANDIDATES) {
    candidates.push(path.join(downloads, stem, name));
    candidates.push(path.join(downloads, stem, 'md', name));
    candidates.push(path.join(downloads, `${stem}.md`));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 扫 downloads/ 找 full.md 并回填账本。
 * apply=false 只报告不写（默认），避免误把半成品记成已完成。
 */
export function parseAudit(run, { apply = false } = {}) {
  const found = [];
  const missing = [];
  const failed = [];

  for (const record of run.records) {
    if (record.download.status !== 'ok') continue;
    const fullMd = findFullMd(run, record);
    if (fullMd) {
      const rel = path.relative(run.dir, fullMd).replace(/\\/g, '/');
      found.push({ n: record.n, fullMd: rel, size: fs.statSync(fullMd).size });
      if (apply) {
        record.parse = { status: 'ok', fullMd: rel, failReason: null, provider: 'dsh-pdf-mineru' };
      }
    } else if (record.parse.status === 'ok') {
      failed.push({ n: record.n, note: '账本标 ok 但磁盘上找不到 full.md' });
    } else {
      missing.push(record.n);
    }
  }

  return {
    runId: run.runId,
    applied: apply,
    downloaded: run.records.filter((record) => record.download.status === 'ok').length,
    found: found.length,
    missing,
    drifted: failed,
    items: found.slice(0, 50),
    omitted: Math.max(found.length - 50, 0),
  };
}
