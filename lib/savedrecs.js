/**
 * WOS 纯文本导出（Full Record）解析器。
 *
 * 三条硬规则，每条都来自实跑事故：
 *  1. 按「整行恰好是 ER」切记录 —— 按子串切会把 ELSEVIER / ENERGY / CERAMIC 里的 ER 当分隔符撕碎记录。
 *  2. 先剥 UTF-8 BOM —— WOS 导出是 utf-8-sig，不剥则首行标签变成 "\uFEFFPT"。
 *  3. CR（引文表）整段丢弃 —— 单条记录可达上百行，留在账本里会让 run.json 膨胀一个数量级。
 */

/** 重复出现即列表的标签。 */
const LIST_TAGS = new Set(['AU', 'AF', 'C1', 'C3', 'EM', 'RI', 'OI']);

/** 完全不读的标签：引文表与文件级头尾。 */
const IGNORED_TAGS = new Set(['CR', 'FN', 'VR', 'EF']);

const TAG_LINE = /^[A-Z0-9]{2}$/;
const CONTINUATION = /^ {3}/;

function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function splitSemi(value) {
  return String(value ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function toYear(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 1000 && parsed < 3000 ? parsed : null;
}

function toList(value) {
  if (Array.isArray(value)) return value.map(collapse).filter(Boolean);
  const single = collapse(value);
  return single ? [single] : [];
}

function finish(state) {
  const tags = state.tags;
  const doiRaw = collapse(tags.DI);
  return {
    ut: collapse(tags.UT) || null,
    title: collapse(tags.TI),
    authorsShort: toList(tags.AU),
    authorsFull: toList(tags.AF),
    corresponding: collapse(tags.RP),
    email: toList(tags.EM)[0] ?? null,
    year: toYear(tags.PY),
    journal: collapse(tags.SO),
    j9: collapse(tags.J9),
    publisher: collapse(tags.PU) || null,
    doi: doiRaw || null,
    abstract: collapse(tags.AB),
    authorKeywords: splitSemi(tags.DE),
    wosKeywords: splitSemi(tags.ID),
    cited: Number.parseInt(collapse(tags.TC), 10) || 0,
    docType: collapse(tags.DT),
  };
}

function blank() {
  return { tags: Object.create(null) };
}

/**
 * @param {string} text 导出文件的原始内容
 * @returns {Array<object>} 规范化后的记录，保持导出顺序
 */
export function parseSavedrecs(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const records = [];
  let current = null;
  let lastTag = null;

  for (const rawLine of clean.split('\n')) {
    const line = rawLine.replace(/[ \t]+$/, '');

    if (line === 'ER') {
      if (current) records.push(finish(current));
      current = null;
      lastTag = null;
      continue;
    }

    if (line === '') {
      lastTag = null;
      continue;
    }

    const tag = line.slice(0, 2);

    if (IGNORED_TAGS.has(tag)) {
      lastTag = null;
      continue;
    }

    if (CONTINUATION.test(line)) {
      if (current && lastTag) {
        if (LIST_TAGS.has(lastTag)) {
          current.tags[lastTag].push(line.trim());
        } else {
          current.tags[lastTag] = `${current.tags[lastTag]} ${line.trim()}`.trim();
        }
      }
      continue;
    }

    if (!TAG_LINE.test(tag)) {
      lastTag = null;
      continue;
    }

    if (tag === 'PT' || current === null) current = blank();

    const value = line.slice(2).trim();
    if (LIST_TAGS.has(tag)) {
      if (!Array.isArray(current.tags[tag])) current.tags[tag] = [];
      if (value) current.tags[tag].push(value);
    } else if (lastTag === tag) {
      current.tags[tag] = `${current.tags[tag]} ${value}`.trim();
    } else {
      current.tags[tag] = value;
    }
    lastTag = tag;
  }

  if (current) records.push(finish(current));
  return records;
}

/**
 * 按 UT 去重（无 UT 的按标题+年份兜底），并给出丢弃数量。
 * @param {Array<object>} records
 */
export function dedupe(records) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const record of records) {
    const key = record.ut || `${record.title}\u0000${record.year ?? ''}`;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push(record);
  }
  return { records: kept, dropped };
}

/**
 * 转成账本记录：加序号与三个阶段占位状态。
 * @param {Array<object>} parsed
 */
export function toLedgerRecords(parsed) {
  return parsed.map((record, index) => ({
    n: index + 1,
    ut: record.ut,
    title: record.title,
    authorsShort: record.authorsShort,
    authorsFull: record.authorsFull,
    corresponding: record.corresponding,
    email: record.email,
    year: record.year,
    journal: record.journal,
    j9: record.j9,
    publisher: record.publisher ?? null,
    doi: record.doi,
    abstract: record.abstract,
    authorKeywords: record.authorKeywords,
    wosKeywords: record.wosKeywords,
    cited: record.cited,
    docType: record.docType,
    level: null,
    levelBasis: null,
    subjectSystem: null,
    download: { status: 'pending', file: null, failReason: null },
    parse: { status: 'pending', fullMd: null, failReason: null, provider: null },
  }));
}

/** 一条记录的规范 PDF 文件名（P1 的 wos_pdf_intake 会用它，这里先固化成纯函数以便单测）。 */
export function canonicalPdfName(record) {
  const seq = String(record.n ?? 0).padStart(3, '0');
  const journal = collapse(record.j9 || record.journal).replace(/[^A-Za-z0-9]/g, '') || 'NA';
  const year = record.year ?? 'ND';
  const stop = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'and', 'for', 'to', 'with', 'by', 'at', 'from']);
  const words = collapse(record.title)
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 2 && !stop.has(word.toLowerCase()))
    .slice(0, 5);
  const stem = words.length > 0 ? words.join('_') : 'untitled';
  return `${seq}_${journal}_${year}_${stem}.pdf`;
}
