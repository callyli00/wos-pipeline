/**
 * run.json 账本：唯一写入方、阶段状态机、数量闸门与磁盘漂移检测。
 *
 * 设计约束：
 *  - 模型没有任何直接写 run.json / records.md 的路径，只能经由工具。
 *  - 每次写入都是「先写临时文件再 rename」，中途失败不会留下半截账本。
 *  - 阶段推进带前置条件；不满足就拒绝，并把「该补哪一步」写进错误里。
 *  - **闸门未过时检索式只能由用户确认后修改**：reviseQuery 强制 confirmedByUser，
 *    模型自行加词/改字段/换运算符在结构上被拒绝。
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeRunId } from './ids.js';
import { renderRecordsMd } from './render.js';

export const SCHEMA_VERSION = 2;

/** 阶段顺序。 */
export const STAGES = ['created', 'imported', 'classified', 'downloading', 'downloaded', 'parsed', 'wiki'];

/** 分级 → 梯度键。 */
export const LEVEL_TO_GRADIENT = { 高: 'high', 中: 'mid', 低: 'low' };

const LEVELS = new Set(['高', '中', '低']);
const DOWNLOAD_STATES = new Set(['pending', 'ok', 'fail']);
const PARSE_STATES = new Set(['pending', 'ok', 'fail']);

export class RunError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'RunError';
    this.code = code;
    this.detail = detail;
  }
}

export function runPaths(dir) {
  return {
    dir,
    json: path.join(dir, 'run.json'),
    md: path.join(dir, 'records.md'),
    downloads: path.join(dir, 'downloads'),
    quarantine: path.join(dir, '_quarantine'),
  };
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** 检索式比较口径：忽略空白与大小写差异，别让排版差异被当成「改了式子」。 */
export function normalizeQuery(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** v1 账本就地升级到 v2，不丢历史。 */
function migrateV1(parsed) {
  parsed.schemaVersion = SCHEMA_VERSION;
  parsed.attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
  if (Array.isArray(parsed.records)) {
    for (const record of parsed.records) {
      if (!('publisher' in record)) record.publisher = null;
      if (record.parse && !('provider' in record.parse)) record.parse.provider = null;
    }
  }
  const gate = parsed.gate ?? {};
  parsed.gate = {
    min: gate.min ?? 50,
    max: gate.max ?? 300,
    n: gate.n ?? null,
    verdict: gate.verdict ?? 'pending',
    awaitingUser: gate.verdict === 'too-narrow' || gate.verdict === 'too-wide',
    waived: false,
    waivedReason: null,
    maxAttempts: gate.maxAttempts ?? 3,
    capReached: false,
  };
  if (parsed.gate.n !== null && parsed.attempts.length === 0) {
    parsed.attempts.push({
      round: 1,
      query: parsed.query,
      n: parsed.gate.n,
      verdict: parsed.gate.verdict,
      at: parsed.updatedAt ?? new Date().toISOString(),
    });
  }
  parsed.wiki = parsed.wiki ?? null;
  return parsed;
}

export function readRun(dir) {
  const paths = runPaths(dir);
  if (!fs.existsSync(paths.json)) {
    throw new RunError('RUN_NOT_FOUND', `找不到账本：${paths.json}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
  } catch (error) {
    throw new RunError('RUN_UNREADABLE', `账本不是合法 JSON：${paths.json}`, String(error));
  }
  if (parsed.schemaVersion === 1) {
    parsed = migrateV1(parsed);
    writeRun(parsed);
    return parsed;
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new RunError(
      'RUN_SCHEMA_MISMATCH',
      `账本 schemaVersion=${parsed.schemaVersion}，本插件只认 ${SCHEMA_VERSION}：${paths.json}`,
    );
  }
  if (!Array.isArray(parsed.records)) {
    throw new RunError('RUN_MALFORMED', `账本缺少 records 数组：${paths.json}`);
  }
  parsed.attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
  return parsed;
}

export function writeRun(run) {
  run.updatedAt = new Date().toISOString();
  const paths = runPaths(run.dir);
  fs.mkdirSync(run.dir, { recursive: true });
  atomicWrite(paths.json, JSON.stringify(run, null, 2));
  fs.writeFileSync(paths.md, renderRecordsMd(run), 'utf8');
  return run;
}

export function createRun({ root, topic, query, database, gate, maxAttempts = 3 }) {
  const topicText = String(topic ?? '').trim();
  const queryText = String(query ?? '').trim();
  if (!topicText) throw new RunError('TOPIC_REQUIRED', 'topic 不能为空');
  if (!queryText) throw new RunError('QUERY_REQUIRED', 'query 不能为空（要写出实际敲进检索框的那条式子）');

  const dir = path.join(root, makeRunId(topicText));
  if (fs.existsSync(runPaths(dir).json)) {
    return { run: readRun(dir), created: false };
  }

  const now = new Date().toISOString();
  const run = {
    schemaVersion: SCHEMA_VERSION,
    runId: makeRunId(topicText),
    dir,
    topic: topicText,
    query: queryText,
    database: String(database ?? 'Web of Science Core Collection').trim(),
    gate: {
      min: gate.min,
      max: gate.max,
      n: null,
      verdict: 'pending',
      awaitingUser: false,
      waived: false,
      waivedReason: null,
      maxAttempts,
      capReached: false,
    },
    attempts: [],
    stage: 'created',
    gradients: { selected: [], counted: { high: 0, mid: 0, low: 0 } },
    wiki: null,
    createdAt: now,
    updatedAt: now,
    records: [],
  };
  fs.mkdirSync(runPaths(dir).downloads, { recursive: true });
  return { run: writeRun(run), created: true };
}

/**
 * 数量闸门。verdict 不是 passed 时，**下一步只能是与用户一起定检索词**，
 * 所以每个非通过分支都带 needsUserInteraction 与 askUser 文案。
 */
export function evaluateGate(run, n) {
  const { min, max } = run.gate;
  if (n < min) {
    return {
      n,
      verdict: 'too-narrow',
      needsUserInteraction: true,
      diagnosis: [
        'AND 层可能过多：去掉最窄的一层，看 N 是否回到区间',
        '同义词太窄：补缩写、单复数、连字符变体与通配符',
        '体系词过度限定：把具体体系换成更宽的上位表述',
        '字段太精准：把 AU/SO/TI+AB 放宽到 Topic',
      ],
      askUser: `N=${n} 低于下限 ${min}：把 N、诊断和候选放宽方案摆给用户，由用户选定下一轮检索词；不要自行加同义词或删层。`,
    };
  }
  if (n > max) {
    return {
      n,
      verdict: 'too-wide',
      needsUserInteraction: true,
      diagnosis: [
        '缺约束层：补一层最小的 AND（材料/方法/性能任选其最贴题的）',
        '高频词泛化：把裸词换成带引号的短语',
        '字段太宽：把 Topic 收紧成 TI+AB 或 Title',
        '加一层 NOT 排除最大的一坨跑偏主题（减法比加法更省召回）',
        '先保持原式，靠后续分类与梯度下载兜底（需用户明确豁免闸门）',
      ],
      askUser: `N=${n} 超过上限 ${max}（超出 ${Math.round(((n - max) / max) * 100)}%）：把 N、诊断和候选收紧方案摆给用户，由用户选定下一轮检索词；不要自行加词或改字段。`,
    };
  }
  return { n, verdict: 'passed', needsUserInteraction: false, diagnosis: [], askUser: null };
}

/** 把一次导入结果记进迭代历史；这是「3 轮上限」的唯一计数来源。 */
export function recordAttempt(run, { query, n, verdict }) {
  const attempt = {
    round: run.attempts.length + 1,
    query: String(query ?? run.query),
    n,
    verdict,
    at: new Date().toISOString(),
  };
  run.attempts.push(attempt);
  run.gate.n = n;
  run.gate.verdict = verdict;
  run.gate.awaitingUser = verdict === 'too-narrow' || verdict === 'too-wide';
  run.gate.capReached = run.attempts.length >= run.gate.maxAttempts && run.gate.verdict !== 'passed';
  return attempt;
}

/** 用户确认后的检索式修订。未带 confirmedByUser 一律拒绝。 */
export function reviseQuery(run, { query, confirmedByUser, userDecided, note }) {
  const queryText = String(query ?? '').trim();
  if (!queryText) throw new RunError('QUERY_REQUIRED', 'query 不能为空');
  if (confirmedByUser !== true) {
    throw new RunError(
      'QUERY_NOT_CONFIRMED',
      [
        '检索式变更必须由用户确认，模型不得自行改词。',
        '做法：把当前 N、闸门诊断和 2–3 条候选式子摆给用户 → 用户选定 → 再调本工具并带 confirmedByUser: true。',
      ].join(''),
    );
  }
  if (run.gate.capReached && userDecided !== true) {
    throw new RunError(
      'GATE_CAP_REACHED',
      [
        `已导入 ${run.attempts.length} 轮且仍未进 ${run.gate.min}–${run.gate.max}。`,
        '把历次 N 值与式子摆给用户拍板：继续修订（带 userDecided: true）或豁免闸门（导入时带 acceptOutOfRange: true）。',
      ].join(''),
    );
  }
  const before = run.query;
  run.query = queryText;
  run.gate.awaitingUser = false;
  return { before, after: queryText, note: note ? String(note).trim() : null };
}

/** 用户明确豁免闸门时调用，账本留下豁免理由。 */
export function waiveGate(run, reason) {
  const text = String(reason ?? '').trim();
  if (!text) throw new RunError('WAIVE_REASON_REQUIRED', 'acceptOutOfRange 必须同时给 acceptReason（为什么接受区间外条数）');
  run.gate.verdict = 'waived';
  run.gate.waived = true;
  run.gate.waivedReason = text;
  run.gate.awaitingUser = false;
  return run.gate;
}

export function counts(run) {
  const tally = (pick) => {
    const out = { ok: 0, fail: 0, pending: 0 };
    for (const record of run.records) out[pick(record)] += 1;
    return out;
  };
  return {
    n: run.records.length,
    high: run.records.filter((r) => r.level === '高').length,
    mid: run.records.filter((r) => r.level === '中').length,
    low: run.records.filter((r) => r.level === '低').length,
    unclassified: run.records.filter((r) => !r.level).length,
    noDoi: run.records.filter((r) => !r.doi).length,
    download: tally((r) => r.download.status),
    parse: tally((r) => r.parse.status),
  };
}

/** 选中梯度内的记录（下载/解析的工作集合）。 */
export function inGradients(run, record) {
  const key = LEVEL_TO_GRADIENT[record.level];
  return Boolean(key) && run.gradients.selected.includes(key);
}

export function pendingDownloads(run) {
  return run.records.filter((r) => inGradients(run, r) && r.download.status === 'pending');
}

export function pendingParses(run) {
  return run.records.filter((r) => r.download.status === 'ok' && r.parse.status === 'pending');
}

/** 前置条件不满足时返回一条可读的原因，满足则返回 null。 */
export function preconditionFailure(run, target) {
  switch (target) {
    case 'imported':
      if (run.records.length === 0) return '账本还没有记录，先导入 WOS 导出文件';
      if (run.gate.verdict !== 'passed' && run.gate.verdict !== 'waived') {
        return `数量闸门未通过（N=${run.gate.n}，判定 ${run.gate.verdict}），先把检索式调进 ${run.gate.min}–${run.gate.max}，或由用户明确豁免`;
      }
      return null;
    case 'classified': {
      const pending = run.records.filter((r) => !r.level).map((r) => r.n);
      if (pending.length > 0) return `还有 ${pending.length} 条未分级：${pending.slice(0, 12).join(', ')}`;
      return null;
    }
    case 'downloading':
      if (run.gradients.selected.length === 0) return '还没有选择要下载的梯度（gradients.selected 为空）';
      return null;
    case 'downloaded': {
      const pending = pendingDownloads(run).map((r) => r.n);
      if (pending.length > 0) return `选中梯度里还有 ${pending.length} 条下载状态是 pending：${pending.slice(0, 12).join(', ')}`;
      return null;
    }
    case 'parsed': {
      const pending = pendingParses(run).map((r) => r.n);
      if (pending.length > 0) return `还有 ${pending.length} 条已下载但未解析：${pending.slice(0, 12).join(', ')}`;
      return null;
    }
    case 'wiki':
      if (!run.wiki || !run.wiki.root) return '还没有建 wiki：先 wos_wiki_init';
      return null;
    default:
      return `未知阶段：${target}`;
  }
}

export function advanceTo(run, target) {
  const fromIndex = STAGES.indexOf(run.stage);
  const toIndex = STAGES.indexOf(target);
  if (toIndex < 0) throw new RunError('UNKNOWN_STAGE', `未知阶段：${target}`);
  if (toIndex <= fromIndex) return run;
  const failure = preconditionFailure(run, target);
  if (failure) throw new RunError('PRECONDITION_FAILED', failure);
  run.stage = target;
  return run;
}

/** 账本与磁盘的一致性：downloads/ 里的 PDF 与标了 ok 的记录是否对得上。 */
export function diskDrift(run) {
  const paths = runPaths(run.dir);
  let files = [];
  if (fs.existsSync(paths.downloads)) {
    files = fs
      .readdirSync(paths.downloads, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
      .map((entry) => entry.name);
  }
  const markedOk = run.records.filter((r) => r.download.status === 'ok');
  const missing = markedOk
    .filter((r) => !r.download.file || !files.includes(r.download.file))
    .map((r) => r.n);
  const unaccounted = files.filter((file) => !markedOk.some((r) => r.download.file === file));
  return { pdfFiles: files.length, markedOk: markedOk.length, missing, unaccounted };
}

/** 下一动作。工具名与参数要能直接照抄执行。 */
export function nextStep(run) {
  const tally = counts(run);
  const gate = run.gate;
  // 只有「真的判过且没过」才该把用户拉进来；pending（还没导入过）不算。
  const gateFailed = gate.verdict === 'too-narrow' || gate.verdict === 'too-wide';

  if ((run.stage === 'created' || run.stage === 'imported') && gateFailed) {
    return {
      tool: 'wos_query_revise',
      args: {
        runId: run.runId,
        query: '<与用户一起确认后的新检索式>',
        confirmedByUser: true,
        ...(gate.capReached ? { userDecided: true } : {}),
      },
      requiresUserInteraction: true,
      askUser: gate.capReached
        ? `已 ${run.attempts.length} 轮未进区间（历次 N：${run.attempts.map((a) => a.n).join(' / ')}）。把历次结果摆给用户：继续修订或豁免闸门。`
        : `N=${gate.n}（判定 ${gate.verdict}）：把诊断和候选式子摆给用户，一起定下一轮检索词。`,
      reason: `数量闸门未通过（N=${gate.n}）：按用户选定的检索式重跑检索 → 重新导出 → 重新导入`,
    };
  }

  switch (run.stage) {
    case 'created':
      return {
        tool: 'wos_import_records',
        args: { runId: run.runId, path: '<WOS 导出的 savedrecs.txt 绝对路径>' },
        reason: '账本还没有记录：先在结果页 Export（Plain text file + Full Record + 1 到 N），再导入',
      };
    case 'imported':
      return {
        tool: 'wos_records_update',
        args: {
          runId: run.runId,
          patch: [{ n: 1, level: '高', levelBasis: '一句话依据', subjectSystem: '主体体系' }],
        },
        reason: `还有 ${tally.unclassified} 条未分级：先做完高/中/低分级，再进入下载`,
      };
    case 'classified':
      return {
        tool: 'wos_records_update',
        args: { runId: run.runId, gradients: { selected: ['high', 'mid'] } },
        reason: '分级完成：确认要下载哪些梯度（高 / 中 / 低），然后进入按出版商分组的下载循环',
      };
    case 'downloading':
      return {
        tool: 'wos_download_plan',
        args: { runId: run.runId, groupBy: 'publisher' },
        reason: `选中梯度里还有 ${pendingDownloads(run).length} 条待下载：按出版商分组集中下载，每篇落盘后立刻 wos_pdf_intake 收编`,
      };
    case 'downloaded':
      return {
        tool: 'wos_parse_plan',
        args: { runId: run.runId },
        reason: `还有 ${pendingParses(run).length} 条待解析：按计划逐篇交给 dsh-pdf-mineru，完成后 wos_parse_audit 回填`,
      };
    case 'parsed':
      return {
        tool: 'wos_wiki_init',
        args: { runId: run.runId },
        reason: '解析完成：建知识库骨架，然后按 llm-wiki 口径批量建页',
      };
    default:
      return {
        tool: 'wos_wiki_lint',
        args: { runId: run.runId },
        reason: '知识库已建：跑一次 lint 收口，再按报告补链接与标签',
      };
  }
}

function assertPatchItem(item, index) {
  if (!item || typeof item !== 'object') {
    throw new RunError('PATCH_INVALID', `patch[${index}] 必须是对象`);
  }
  if (!Number.isInteger(item.n) || item.n < 1) {
    throw new RunError('PATCH_INVALID', `patch[${index}].n 必须是正整数记录序号`);
  }
  if (item.level !== undefined && !LEVELS.has(item.level)) {
    throw new RunError('PATCH_INVALID', `patch[${index}].level 只能是 高 / 中 / 低`);
  }
  if (item.level !== undefined && !String(item.levelBasis ?? '').trim()) {
    throw new RunError('PATCH_INVALID', `patch[${index}] 设了 level 就必须给 levelBasis（一句话依据）`);
  }
  if (item.download !== undefined) {
    if (!DOWNLOAD_STATES.has(item.download?.status)) {
      throw new RunError('PATCH_INVALID', `patch[${index}].download.status 只能是 pending / ok / fail`);
    }
    if (item.download.status === 'fail' && !String(item.download.failReason ?? '').trim()) {
      throw new RunError('PATCH_INVALID', `patch[${index}].download.status=fail 必须给 failReason`);
    }
  }
  if (item.parse !== undefined) {
    if (!PARSE_STATES.has(item.parse?.status)) {
      throw new RunError('PATCH_INVALID', `patch[${index}].parse.status 只能是 pending / ok / fail`);
    }
    if (item.parse.status === 'fail' && !String(item.parse.failReason ?? '').trim()) {
      throw new RunError('PATCH_INVALID', `patch[${index}].parse.status=fail 必须给 failReason`);
    }
  }
}

/**
 * 批量写入。任一条目不合法则整批拒绝 —— 不做部分写入。
 */
export function applyPatch(run, patch, gradients) {
  if (!Array.isArray(patch) || patch.length === 0) {
    if (!gradients) throw new RunError('PATCH_EMPTY', 'patch 为空且未给 gradients，没有可写入的内容');
    patch = [];
  }
  const byNumber = new Map(run.records.map((record) => [record.n, record]));
  patch.forEach((item, index) => {
    assertPatchItem(item, index);
    if (!byNumber.has(item.n)) {
      throw new RunError('PATCH_UNKNOWN_RECORD', `patch[${index}].n=${item.n} 不在本次账本里（共 ${run.records.length} 条）`);
    }
  });

  const changed = [];
  for (const item of patch) {
    const record = byNumber.get(item.n);
    const set = (field, value) => {
      if (record[field] === value) return;
      changed.push({ n: record.n, field, from: record[field], to: value });
      record[field] = value;
    };
    set('level', item.level ?? record.level);
    if (item.level !== undefined) {
      set('levelBasis', String(item.levelBasis).trim());
      set('subjectSystem', item.subjectSystem ? String(item.subjectSystem).trim() : null);
    }
    if (item.download !== undefined) {
      set('download', {
        status: item.download.status,
        file: item.download.file ?? record.download.file ?? null,
        failReason: item.download.failReason ? String(item.download.failReason) : null,
      });
    }
    if (item.parse !== undefined) {
      set('parse', {
        status: item.parse.status,
        fullMd: item.parse.fullMd ?? record.parse.fullMd ?? null,
        failReason: item.parse.failReason ? String(item.parse.failReason) : null,
        provider: item.parse.provider ?? record.parse.provider ?? null,
      });
    }
  }

  let appliedGradients = null;
  if (gradients) {
    const selected = Array.isArray(gradients.selected) ? gradients.selected : [];
    const allowed = new Set(['high', 'mid', 'low']);
    const bad = selected.filter((value) => !allowed.has(value));
    if (bad.length > 0) {
      throw new RunError('GRADIENTS_INVALID', `gradients.selected 只能含 high / mid / low，收到 ${bad.join(', ')}`);
    }
    appliedGradients = { selected: [...new Set(selected)] };
    run.gradients = { ...run.gradients, selected: appliedGradients.selected };
  }

  const tally = counts(run);
  run.gradients = { ...run.gradients, counted: { high: tally.high, mid: tally.mid, low: tally.low } };

  return { changed, gradients: appliedGradients };
}

/**
 * 按账本内容把 stage 推到它够得着的最远处。只前进，不倒退。
 */
export function syncStage(run) {
  for (const target of STAGES) {
    if (STAGES.indexOf(target) <= STAGES.indexOf(run.stage)) continue;
    if (preconditionFailure(run, target) === null) {
      run.stage = target;
    } else {
      break;
    }
  }
  return run;
}

const FILTERS = new Set([
  'all',
  'unclassified',
  'high',
  'mid',
  'low',
  'no-doi',
  'download-failed',
  'download-pending',
  'parse-pending',
]);

export function selectRecords(run, filter) {
  const name = filter || 'all';
  if (!FILTERS.has(name)) {
    throw new RunError('FILTER_INVALID', `filter 只能是 ${[...FILTERS].join(' / ')}`);
  }
  switch (name) {
    case 'unclassified':
      return run.records.filter((r) => !r.level);
    case 'high':
      return run.records.filter((r) => r.level === '高');
    case 'mid':
      return run.records.filter((r) => r.level === '中');
    case 'low':
      return run.records.filter((r) => r.level === '低');
    case 'no-doi':
      return run.records.filter((r) => !r.doi);
    case 'download-failed':
      return run.records.filter((r) => r.download.status === 'fail');
    case 'download-pending':
      return run.records.filter((r) => r.download.status === 'pending');
    case 'parse-pending':
      return run.records.filter((r) => r.parse.status === 'pending');
    default:
      return run.records;
  }
}
