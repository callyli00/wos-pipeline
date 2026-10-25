/**
 * 模型的可见工具（17 个）。
 *
 * 契约要求（实测自 host Service `tools`）：每个 ToolDefinition 必须给 `output`,
 * 形如 `{ schema, render(args, value) => ContentBlock[] }`，ContentBlock 就是
 * `{ type: 'text', text }`。只写 execute 会注册失败。
 *
 * 阶段编排：created → imported（闸门）→ classified → downloading（收编）
 * → downloaded → parsed（复用 dsh-pdf-mineru）→ wiki（建库与 lint 的机械能力）。
 *
 * 全流程自足：不依赖任何 skill。阶段口径写在 data/playbook/*.md，工具在合适的时点把它们带出来。
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseSavedrecs, dedupe, toLedgerRecords } from './savedrecs.js';
import {
  RunError,
  readRun,
  writeRun,
  createRun,
  evaluateGate,
  recordAttempt,
  reviseQuery,
  waiveGate,
  counts,
  diskDrift,
  nextStep,
  syncStage,
  applyPatch,
  selectRecords,
  ensureGuard,
  guardBlock,
  noteIntakeGuard,
  reportHygiene,
  setHumanGate,
  resolveHumanGate,
  runPaths,
  normalizeQuery,
  pendingDownloads,
  pendingParses,
} from './run.js';
import { downloadPlan, intakePdf, auditDownloads } from './download.js';
import { parsePlan, parseAudit } from './parse.js';
import { wikiInit, stageRaw, wikiLint, wikiIndex, wikiQuery, wikiArchive, LAYERS } from './wiki.js';
import { guidance, discipline } from './playbook.js';

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

const output = (schema) => ({ schema, render: (_args, value) => text(value) });

const OBJ = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

function fail(error) {
  if (error instanceof RunError) {
    const suffix = error.code ? ` [${error.code}]` : '';
    throw new Error(`${error.message}${suffix}`);
  }
  throw error;
}

function baseRoot(resolved) {
  return resolved.runsRoot || process.cwd();
}

function runDirOf(resolved, args) {
  if (typeof args?.dir === 'string' && args.dir.trim()) return path.resolve(args.dir.trim());
  if (typeof args?.runId === 'string' && args.runId.trim()) {
    return path.resolve(baseRoot(resolved), args.runId.trim());
  }
  throw new RunError('RUN_REQUIRED', '需要 dir（任务目录绝对路径）或 runId 之一');
}

function resolveWikiRoot(resolved, args, run) {
  if (typeof args?.wikiRoot === 'string' && args.wikiRoot.trim()) return path.resolve(args.wikiRoot.trim());
  if (run?.wiki?.root) return run.wiki.root;
  if (resolved.wikiRoot) return path.resolve(resolved.wikiRoot);
  // 默认放在**任务目录内**：<run dir>/LLM_WiKi_KnowledgeBase（便于整个任务一起搬走/归档）。
  // 不用 Host 进程 cwd —— 实测它可能是系统临时目录。
  if (run?.dir) return path.join(run.dir, 'LLM_WiKi_KnowledgeBase');
  return path.resolve(baseRoot(resolved), 'LLM_WiKi_KnowledgeBase');
}

function listRunsUnder(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('wos_')) continue;
    const dir = path.join(root, entry.name);
    try {
      const run = readRun(dir);
      found.push({
        runId: run.runId,
        dir: run.dir,
        topic: run.topic,
        stage: run.stage,
        n: run.records.length,
        gate: `${run.gate.verdict}${run.gate.waived ? '(waived)' : ''}`,
        updatedAt: run.updatedAt,
      });
    } catch {
      /* 不是账本目录，忽略 */
    }
  }
  return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const RUN_SELECTOR = {
  dir: { type: 'string', description: '任务目录绝对路径；与 runId 二选一' },
  runId: { type: 'string', description: 'wos_<主题>_<日期>；会拼到 runsRoot 下' },
};

const GRADIENT_PARAM = {
  type: 'string',
  enum: ['high', 'mid', 'low'],
  description: '只处理某一梯度；省略则用账本里已选的梯度',
};

export function createTools(resolved) {
  return [
    // ---------------------------------------------------------------- create
    {
      name: 'wos_run_create',
      description:
        '为一个 WOS 检索主题建立流水线账本，返回 runId 与目录。后续所有状态都以这个 run 为根；同名 run 已存在时原样返回既有账本，不覆盖。',
      parameters: OBJ(
        {
          topic: { type: 'string', description: '自然语言主题，用来生成目录名' },
          query: {
            type: 'string',
            description: '已确认的完整检索式，字面上要敲进 WOS 检索框的那条；不要写"若干关键词"之类的概述',
          },
          database: { type: 'string', description: '数据库；默认 Web of Science Core Collection' },
          runsRoot: {
            type: 'string',
            description: '任务目录的父目录绝对路径；省略时用插件配置，再回落 Host 进程当前目录',
          },
        },
        ['topic', 'query'],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const root = typeof args?.runsRoot === 'string' && args.runsRoot.trim()
            ? path.resolve(args.runsRoot.trim())
            : path.resolve(baseRoot(resolved));
          const { run, created } = createRun({
            root,
            topic: args.topic,
            query: args.query,
            database: args.database,
            gate: resolved.gate,
            maxAttempts: resolved.gate.maxAttempts,
          });
          return {
            created,
            runId: run.runId,
            dir: run.dir,
            stage: run.stage,
            recordsMd: runPaths(run.dir).md,
            gate: run.gate,
            next: nextStep(run),
            guidance: guidance(run.stage),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({
        type: 'object',
        properties: {
          created: { type: 'boolean' },
          runId: { type: 'string' },
          dir: { type: 'string' },
          stage: { type: 'string' },
          recordsMd: { type: 'string' },
        },
      }),
    },

    // ----------------------------------------------------------------- status
    {
      name: 'wos_run_status',
      description:
        '返回一个 run 的阶段、各阶段计数、数量闸门判定与迭代历史、账本与磁盘不一致项、下一步该调哪个工具。不带 dir/runId 时列出 runsRoot 下所有 run。页面状态只能用结构读取（observe / html），禁止用截图做视觉判断。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          verifyDisk: { type: 'boolean', description: '是否比对 downloads/ 实际文件与账本标记；默认 true' },
        },
        [],
      ),
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const hasSelector = Boolean(args?.dir || args?.runId);
          if (!hasSelector) {
            return {
              runs: listRunsUnder(path.resolve(baseRoot(resolved))),
              runsRoot: path.resolve(baseRoot(resolved)),
              defaultWikiRoot: path.resolve(resolved.wikiRoot || path.join(baseRoot(resolved), 'LLM_WiKi_KnowledgeBase')),
            };
          }
          const run = readRun(runDirOf(resolved, args));
          const verifyDisk = args?.verifyDisk !== false;
          const tally = counts(run);
          const guard = ensureGuard(run);
          const blocked = guardBlock(run);
          const payload = {
            runId: run.runId,
            dir: run.dir,
            topic: run.topic,
            query: run.query,
            stage: run.stage,
            files: { recordsMd: runPaths(run.dir).md },
            counts: tally,
            gate: run.gate,
            attempts: run.attempts,
            gradients: run.gradients.selected,
            pending: { downloads: pendingDownloads(run).length, parses: pendingParses(run).length },
            wiki: run.wiki,
            browserGuard: {
              lastIntakeAt: guard.lastIntakeAt,
              lastHygieneAt: guard.lastHygieneAt,
              intakesSinceHygiene: guard.intakesSinceHygiene,
              agentTabCount: guard.agentTabCount,
              pendingTabCloses: guard.pendingTabCloses,
              humanGate: guard.humanGate,
              recentViolations: guard.violations.slice(-5),
            },
            blocked,
            next: nextStep(run),
            guidance: guidance(run.stage),
          };
          if (run.gate.awaitingUser) {
            payload.gateInteraction = {
              required: true,
              askUser: `N=${run.gate.n}（判定 ${run.gate.verdict}）：把诊断与候选检索式摆给用户，一起定下一轮；模型不得自行改词。`,
            };
          }
          if (verifyDisk) {
            const drift = diskDrift(run);
            const dirty = drift.missing.length > 0 || drift.unaccounted.length > 0;
            payload.disk = dirty ? { ...drift, warning: '账本与磁盘不一致，先 wos_download_audit 核对再继续' } : { pdfFiles: drift.pdfFiles };
          }
          if (!run.disciplineShown) {
            payload.discipline = discipline();
            run.disciplineShown = true;
            writeRun(run);
          }
          return payload;
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ----------------------------------------------------------------- import
    {
      name: 'wos_import_records',
      description:
        '解析 WOS 导出的纯文本文件（Plain text file + Full Record）并整份写入账本，判定数量闸门，并把这次尝试记进迭代历史。未通过闸门时不推进阶段，返回诊断与「必须与用户交互」标记。query 必填：用来核对导出是否就是账本那条式子，不一致会被拒绝。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          path: { type: 'string', description: 'WOS 导出文件的绝对路径（通常是 Downloads/savedrecs.txt）' },
          query: {
            type: 'string',
            description: '产生这份导出的检索式（照抄你实际敲进 WOS 的那条）；与账本不一致会被拒绝，须先 wos_query_revise',
          },
          expectN: { type: 'integer', description: '结果页上看到的 N；给了就与解析条数交叉核对' },
          acceptOutOfRange: {
            type: 'boolean',
            description: '仅在用户明确同意接受区间外条数时置 true；必须同时给 acceptReason',
          },
          acceptReason: { type: 'string', description: '用户为什么接受区间外条数' },
        },
        ['path', 'query'],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const file = path.resolve(String(args.path));
          if (!fs.existsSync(file)) throw new RunError('IMPORT_FILE_MISSING', `找不到导出文件：${file}`);

          if (normalizeQuery(args.query) !== normalizeQuery(run.query)) {
            throw new RunError(
              'QUERY_CHANGED_UNCONFIRMED',
              [
                '导入的检索式与账本记录的不一致，且没有经过用户确认。',
                `账本：${run.query}`,
                `本次：${args.query}`,
                '做法：先把新式子摆给用户确认 → 调 wos_query_revise（带 confirmedByUser: true）→ 再导入。',
              ].join('\n'),
            );
          }

          const parsedRaw = parseSavedrecs(fs.readFileSync(file, 'utf8'));
          if (parsedRaw.length === 0) {
            throw new RunError('IMPORT_EMPTY', `文件里没有解析出任何记录（检查是否选成了 Author, Title, Source）：${file}`);
          }
          const { records: unique, dropped } = dedupe(parsedRaw);
          run.records = toLedgerRecords(unique);

          const gate = evaluateGate(run, run.records.length);
          const attempt = recordAttempt(run, { query: run.query, n: run.records.length, verdict: gate.verdict });

          const warnings = [];
          if (dropped > 0) warnings.push(`按 UT 去重丢弃 ${dropped} 条重复记录`);
          if (Number.isInteger(args.expectN) && args.expectN !== run.records.length) {
            warnings.push(`导出条数 ${run.records.length} 与结果页 N=${args.expectN} 不一致，先核对是否只导出了当前页`);
          }
          const noDoi = run.records.filter((record) => !record.doi).length;
          if (noDoi > 0) warnings.push(`${noDoi} 条没有 DOI，账本里已显式记为 null`);

          let waived = null;
          if (gate.verdict !== 'passed' && args.acceptOutOfRange === true) {
            waived = waiveGate(run, args.acceptReason);
            warnings.push(`闸门被用户豁免（N=${run.records.length}）：${waived.waivedReason}`);
          }

          run.stage = run.gate.verdict === 'passed' || run.gate.verdict === 'waived' ? 'imported' : 'created';
          syncStage(run);
          writeRun(run);

          return {
            imported: run.records.length,
            dropped,
            noDoi,
            attempt,
            attemptsTotal: run.attempts.length,
            gate,
            waived,
            gateInteraction: gate.needsUserInteraction && !waived
              ? {
                  required: true,
                  askUser: gate.askUser,
                  rule: '闸门未过时检索词必须与用户一起定：不得自行加词、删层、改字段或换运算符。',
                  capReached: run.gate.capReached,
                  history: run.attempts.map((item) => ({ round: item.round, n: item.n, verdict: item.verdict })),
                }
              : null,
            stage: run.stage,
            warnings,
            recordsMd: runPaths(run.dir).md,
            next: nextStep(run),
            guidance: guidance(run.stage),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ----------------------------------------------------------------- revise
    {
      name: 'wos_query_revise',
      description:
        '修订检索式。**必须由用户确认**：未带 confirmedByUser: true 一律拒绝。闸门连续未过达到上限（默认 3 轮）后还需 userDecided: true。用于把「与用户一起定下的新检索式」写进账本，然后再去 WOS 重跑检索与导出。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          query: { type: 'string', description: '与用户一起确认后的完整检索式' },
          confirmedByUser: {
            type: 'boolean',
            description: '必须为 true：表示这条式子是与用户确认后定下的，不是模型自己改的',
          },
          userDecided: {
            type: 'boolean',
            description: '超过轮次上限后继续修订时置 true：表示用户已看过历次 N 并决定继续',
          },
          note: { type: 'string', description: '本轮为什么要这么改（一句话，记进历史）' },
        },
        ['query', 'confirmedByUser'],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const change = reviseQuery(run, {
            query: args.query,
            confirmedByUser: args.confirmedByUser,
            userDecided: args.userDecided,
            note: args.note,
          });
          if (args.note) {
            run.attempts.push({
              round: run.attempts.length + 1,
              query: change.after,
              n: null,
              verdict: 'revised',
              note: change.note,
              at: new Date().toISOString(),
            });
          }
          writeRun(run);
          return {
            changed: change,
            gate: run.gate,
            stage: run.stage,
            next: {
              tool: 'wos_import_records',
              args: { runId: run.runId, path: '<新导出文件>', query: change.after },
              reason: '去 WOS 用新式子重跑检索 → Export（Full Record，1 到 N）→ 重新导入（幂等，整份替换）',
            },
            guidance: guidance('imported'),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------------ query
    {
      name: 'wos_records_query',
      description:
        '分页读取账本里的记录，可按分级或状态过滤。默认只回标题级字段；摘要需要显式打开且会被截断，返回结果显式标明省略了多少条。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          filter: {
            type: 'string',
            enum: ['all', 'unclassified', 'high', 'mid', 'low', 'no-doi', 'download-failed', 'download-pending', 'parse-pending'],
            description: '过滤条件；默认 all',
          },
          offset: { type: 'integer', description: '起始位置，从 0 开始；默认 0' },
          limit: { type: 'integer', description: `每页条数，最大 50；默认 ${resolved.pageSize}` },
          withAbstract: { type: 'boolean', description: '是否附带摘要（截断到 300 字）；默认 false' },
        },
        [],
      ),
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const limit = Math.min(Math.max(Number.isInteger(args?.limit) ? args.limit : resolved.pageSize, 1), 50);
          const offset = Math.max(Number.isInteger(args?.offset) ? args.offset : 0, 0);
          const matched = selectRecords(run, args?.filter);
          const page = matched.slice(offset, offset + limit);
          const items = page.map((record) => {
            const base = {
              n: record.n,
              title: record.title,
              year: record.year,
              journal: record.j9 || record.journal,
              publisher: record.publisher,
              doi: record.doi,
              level: record.level,
              download: record.download.status,
              parse: record.parse.status,
            };
            if (args?.withAbstract) {
              const abstract = record.abstract || '';
              base.abstract = abstract.length > 300 ? `${abstract.slice(0, 300)}…` : abstract;
            }
            return base;
          });
          return {
            runId: run.runId,
            filter: args?.filter || 'all',
            total: matched.length,
            offset,
            returned: items.length,
            omitted: matched.length - offset - items.length,
            items,
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ----------------------------------------------------------------- update
    {
      name: 'wos_records_update',
      description:
        '批量写入分类结果（level/levelBasis/subjectSystem）、下载状态或解析状态，也可写入要下载的梯度。任一条目不合法则整批拒绝，不会写入一半。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          patch: {
            type: 'array',
            description: '要写入的记录项；每条用 n 指向账本里的记录序号',
            items: {
              type: 'object',
              properties: {
                n: { type: 'integer', description: '记录序号' },
                level: { type: 'string', enum: ['高', '中', '低'], description: '分级' },
                levelBasis: { type: 'string', description: '一句话依据；设了 level 就必填' },
                subjectSystem: { type: 'string', description: '主体体系标记，用于记录该条是否属于目标主体' },
                download: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['pending', 'ok', 'fail'] },
                    file: { type: 'string', description: 'downloads/ 下的文件名' },
                    failReason: { type: 'string', description: 'status=fail 时必填' },
                  },
                  required: ['status'],
                  additionalProperties: false,
                },
                parse: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['pending', 'ok', 'fail'] },
                    fullMd: { type: 'string', description: 'full.md 的相对路径' },
                    provider: { type: 'string', description: '解析提供方，如 dsh-pdf-mineru' },
                    failReason: { type: 'string', description: 'status=fail 时必填' },
                  },
                  required: ['status'],
                  additionalProperties: false,
                },
              },
              required: ['n'],
              additionalProperties: false,
            },
          },
          gradients: {
            type: 'object',
            description: '要下载的梯度；写入后阶段可推进到 downloading',
            properties: {
              selected: { type: 'array', items: { type: 'string', enum: ['high', 'mid', 'low'] } },
            },
            required: ['selected'],
            additionalProperties: false,
          },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const { changed, gradients } = applyPatch(run, args?.patch, args?.gradients);
          syncStage(run);
          writeRun(run);
          return {
            changed: changed.length,
            details: changed.slice(0, 50),
            omitted: Math.max(changed.length - 50, 0),
            gradients,
            stage: run.stage,
            counts: counts(run),
            next: nextStep(run),
            guidance: guidance(run.stage),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ---------------------------------------------------------- download plan
    {
      name: 'wos_download_plan',
      description:
        '按梯度 + 出版商分组给出待下载清单（同一出版商集中下载，一次会话级校验覆盖整批）。每条带 DOI 链接、规范文件名和该出版商的 PDF 取法提示。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          gradient: GRADIENT_PARAM,
          groupBy: { type: 'string', enum: ['publisher', 'journal'], description: '分组维度；默认 publisher' },
          limit: { type: 'integer', description: '每组最多返回几条；默认 50' },
        },
        [],
      ),
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const blocked = guardBlock(run);
          if (blocked) {
            return {
              blocked: true,
              plan: null,
              reason: blocked.reason,
              requiredTool: blocked.tool,
              requiredArgs: blocked.args,
              requiresUserInteraction: blocked.requiresUserInteraction === true,
              counts: counts(run),
              stage: run.stage,
            };
          }
          const plan = downloadPlan(run, {
            gradient: args?.gradient,
            groupBy: args?.groupBy === 'journal' ? 'journal' : 'publisher',
            limit: Number.isInteger(args?.limit) ? args.limit : 50,
          });
          return { ...plan, guidance: guidance('downloading') };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------ pdf intake
    {
      name: 'wos_pdf_intake',
      description:
        '收编一个已落盘的 PDF：验 %PDF- → 按规范改名 → 移入 downloads/ → 标记 ok。文件名只由 WOS 的 TI/J9/PY 生成，不接受手写。HTML 壳、过小文件直接判 fail 并留原因。sourcePath 是目录时只列出候选文件，不收编。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          n: { type: 'integer', description: '这条 PDF 属于账本第几条记录' },
          sourcePath: { type: 'string', description: '已落盘文件的绝对路径；给目录则列出其中的 PDF 候选' },
          spawnedTabId: {
            type: 'string',
            description:
              '本次点 PDF 链接新开的 tab id（来自 bsk_tabs list 或点击结果）。给了它插件才会登记"待关 tab"——你若忘了关，下一步会被拦住。',
          },
        },
        ['n', 'sourcePath'],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const source = path.resolve(String(args.sourcePath));

          if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
            const files = fs.readdirSync(source, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
              .map((entry) => {
                const abs = path.join(source, entry.name);
                const stat = fs.statSync(abs);
                return { file: entry.name, path: abs, bytes: stat.size, mtime: stat.mtime.toISOString() };
              })
              .sort((a, b) => b.mtime.localeCompare(a.mtime));
            return {
              mode: 'list',
              dir: source,
              count: files.length,
              files: files.slice(0, 40),
              omitted: Math.max(files.length - 40, 0),
              hint: '挑出属于该记录的那个文件，再带 n + sourcePath 调一次完成收编',
            };
          }

          const result = intakePdf(run, { n: args.n, sourcePath: source });
          const tabId = String(args?.spawnedTabId ?? '').trim();
          noteIntakeGuard(run, { spawnedTabId: tabId, n: args.n });
          syncStage(run);
          writeRun(run);
          return {
            mustDoNow: [
              tabId
                ? `bsk_tabs {action:"close", tabId:"${tabId}"}   ← 本次 View PDF 开的新 tab，现在就关`
                : '若本次点击开了新 tab，立刻 bsk_tabs {action:"close", tabId:"…"}（没开可跳过）',
              'bsk_tabs {action:"list", scope:"agent"}   ← 数一下 agent tab，应恒为 1',
              `wos_browser_hygiene {runId:"${run.runId}", agentTabCount:<上一步数出来的条数>}   ← 不做这步，wos_download_plan 会拒绝给下一批`,
            ],
            ...result,
            counts: counts(run),
            stage: run.stage,
            next: nextStep(run),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------ browser hygiene
    {
      name: 'wos_browser_hygiene',
      description:
        '上报一次浏览器 tab 自检：交回已关掉的 tab id，并报出 bsk_tabs {action:"list", scope:"agent"} 的实际条数。每篇收编之后都要调一次；没清干净时返回 ok:false 并列出还差什么，同时阻止下一步下载计划。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          closed: { type: 'array', items: { type: 'string' }, description: '刚刚关掉的 tab id 列表' },
          agentTabCount: {
            type: 'integer',
            description: 'bsk_tabs {action:"list", scope:"agent"} 返回的条数；应恒为 1（多了就先关掉再上报）',
          },
          note: { type: 'string', description: '可选备注' },
        },
        ['agentTabCount'],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const report = reportHygiene(run, {
            closed: args?.closed,
            agentTabCount: args?.agentTabCount,
            note: args?.note,
          });
          writeRun(run);
          return {
            ...report,
            mustDoNow: report.ok ? [] : (report.mustDoNow ?? []),
            stage: run.stage,
            next: nextStep(run),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // -------------------------------------------------------- human verify
    {
      name: 'wos_human_verify',
      description:
        '人机验证交接。prepare（不传 resolved）：把交接写进账本并**直接给出该原样调用的 bsk_assist request-help**——完成判据只接受正向信号（titleText / urlContains），传 textMissing 之类会被拒；resolve（resolved:true）：用户过完后收口。未收口前下载计划不放行。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          reason: { type: 'string', description: '为什么要交人，如 "Elsevier Cloudflare 挑战"' },
          titleText: {
            type: 'string',
            description: '完成判据：论文标题片段（挑战页绝不可能出现）。与 urlContains 至少给一个',
          },
          urlContains: {
            type: 'string',
            description: '完成判据：过验证后才出现的 URL 片段（不要填挑战页也带的 URL）',
          },
          prompt: { type: 'string', description: '给用户看的说明；默认文案已包含"切到 Agent 窗口"' },
          resolved: { type: 'boolean', description: 'true = 用户已完成，收口' },
          outcome: { type: 'string', enum: ['passed', 'cancelled'], description: 'resolve 时的结果' },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          if (args?.resolved === true) {
            const out = resolveHumanGate(run, { outcome: args?.outcome });
            writeRun(run);
            return { ...out, stage: run.stage, next: nextStep(run) };
          }
          const prepared = setHumanGate(run, {
            reason: args?.reason,
            titleText: args?.titleText,
            urlContains: args?.urlContains,
            prompt: args?.prompt,
          });
          writeRun(run);
          return {
            mustDoNow: [
              '按 bskAssistCall 原样调 bsk_assist —— 不要改 completionCriteria，正向信号才会真的等到用户做完',
              '等用户切到 Agent 窗口并完成验证（窗口可能被 agent 占着，用户看不到页面）',
              `用户回来说完成后，调 wos_human_verify {runId:"${run.runId}", resolved:true, outcome:"passed"}`,
            ],
            ...prepared,
            stage: run.stage,
            next: nextStep(run),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // --------------------------------------------------------- download audit
    {
      name: 'wos_download_audit',
      description:
        '下载收尾审计：全库逐文件验 %PDF-、与账本 ✅ 行数对账、列出无主文件并可隔离到 _quarantine/，同时给出「文件名实义词 vs 标题」低重合的可疑项供人工复核（低重合不等于错误）。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          quarantine: { type: 'boolean', description: '把无主文件移入 _quarantine/（默认 false，只报告）' },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const report = auditDownloads(run, { quarantine: args?.quarantine === true });
          syncStage(run);
          writeRun(run);
          return { ...report, counts: counts(run), stage: run.stage, next: nextStep(run) };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------- parse plan
    {
      name: 'wos_parse_plan',
      description:
        '列出待解析的 PDF，并给出可直接照抄的两步调用：async_parse_pdf 解析 → read_pdf(focus:"artifacts") 取产物。解析交给已装的 dsh-pdf-mineru 插件，本插件只记状态。产物统一放到 downloads/<PDF 主名>/full.md。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          gradient: GRADIENT_PARAM,
          limit: { type: 'integer', description: '本次返回几条；默认 40' },
        },
        [],
      ),
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const plan = parsePlan(run, {
            gradient: args?.gradient,
            limit: Number.isInteger(args?.limit) ? args.limit : 40,
          });
          return { ...plan, guidance: guidance('parsed') };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------ parse audit
    {
      name: 'wos_parse_audit',
      description:
        '扫 downloads/ 找 full.md 并回填账本解析状态。apply=false（默认）只报告不写，避免把半成品记成完成。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          apply: { type: 'boolean', description: 'true 才写回账本；默认 false 只报告' },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const report = parseAudit(run, { apply: args?.apply === true });
          if (args?.apply === true) {
            syncStage(run);
            writeRun(run);
          }
          return { ...report, counts: counts(run), stage: run.stage, next: nextStep(run) };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // -------------------------------------------------------------- wiki init
    {
      name: 'wos_wiki_init',
      description:
        '建/补知识库骨架：SCHEMA.md（含标签白名单代码块）、index.md、log.md、papers/README.md、_meta/PROCESS.md（预填每篇一行），以及 papers/entities/concepts/comparisons/queries + raw/papers + _archive。**默认先返回预览、不落盘**：必须把路径摆给用户确认后，再带 confirm: true 调用才真正创建。已存在不覆盖。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          wikiRoot: {
            type: 'string',
            description: '知识库根目录绝对路径；省略则用账本已记的、插件配置的、或默认 <任务目录>/LLM_WiKi_KnowledgeBase',
          },
          domain: { type: 'string', description: '这个 wiki 覆盖的领域（写进 SCHEMA）' },
          tags: { type: 'array', items: { type: 'string' }, description: '初始标签白名单；省略用默认集' },
          confirm: {
            type: 'boolean',
            description: '必须为 true 才真正创建。缺省只返回预览（路径、将创建的文件、已存在的文件），不写任何文件',
          },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const root = path.resolve(resolveWikiRoot(resolved, args, run));
          const planned = ['SCHEMA.md', 'index.md', 'log.md', 'papers/README.md', '_meta/PROCESS.md',
            ...LAYERS.map((layer) => `${layer}/`), 'raw/papers/', 'raw/assets/', '_meta/', '_archive/'];
          // 判定「已存在 / 将创建」要看磁盘真实状态（文件与目录都算）
          const existsOnDisk = (rel) => fs.existsSync(path.join(root, rel.replace(/\/$/, '')));
          const existing = planned.filter(existsOnDisk);
          const willCreate = planned.filter((rel) => !existsOnDisk(rel));

          if (args?.confirm !== true) {
            const recorded = run.wiki?.root ? path.resolve(run.wiki.root) : null;
            const recordedExists = recorded ? fs.existsSync(recorded) : false;
            return {
              mode: 'preview',
              created: [],
              wikiRoot: root,
              exists: fs.existsSync(root),
              existing,
              willCreate,
              recordedRoot: recorded,
              recordedRootExists: recordedExists,
              requiresUserConfirmation: true,
              askUser: [
                `准备把知识库建在：${root}`,
                recorded && recorded !== root ? `（账本当前记录的是：${recorded}${recordedExists ? '' : '，该目录已不存在'}）` : '',
                existing.length > 0 ? `已存在（不覆盖）：${existing.join('、')}` : '目录为空，将全部新建。',
                willCreate.length > 0 ? `将创建：${willCreate.join('、')}` : '无需新建任何文件（骨架已完整）。',
                '把这个路径摆给用户确认；用户点头后再带 confirm: true 调用。',
              ].filter(Boolean).join('\n'),
              records: run.records.length,
            };
          }

          const result = wikiInit({
            wikiRoot: root,
            topic: run.topic,
            domain: args?.domain,
            tags: Array.isArray(args?.tags) ? args.tags : null,
            records: run.records,
          });
          run.wiki = { root: result.wikiRoot, createdAt: new Date().toISOString(), tags: result.tags };
          syncStage(run);
          writeRun(run);
          return {
            ...result,
            layers: LAYERS,
            stage: run.stage,
            next: {
              tool: 'wos_wiki_stage_raw',
              args: { runId: run.runId },
              reason: '骨架就绪：先把已解析全文落到 raw/papers/，再按 wiki 阶段口径批量建 paper/entity/concept 页',
            },
            guidance: guidance('wiki'),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // --------------------------------------------------------- wiki stage raw
    {
      name: 'wos_wiki_stage_raw',
      description:
        '把已解析的全文复制进 raw/papers/<PDF 主名>/，并给 full.md 补 raw frontmatter（source_url / ingested / sha256）。同源重跑按 sha256 判等：一致跳过，不一致报 drift 不静默覆盖。raw/ 落位后只读。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          wikiRoot: { type: 'string', description: '知识库根目录；省略用账本记录的' },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = readRun(runDirOf(resolved, args));
          const root = resolveWikiRoot(resolved, args, run);
          if (!fs.existsSync(path.join(root, 'SCHEMA.md'))) {
            throw new RunError(
              'WIKI_NOT_INITIALIZED',
              `知识库还没建（缺 SCHEMA.md）：${root}。先 wos_wiki_init 拿到预览路径 → 与用户确认 → 带 confirm: true 创建，再落 raw。`,
            );
          }
          const result = stageRaw({ wikiRoot: root, run });
          run.wiki = { ...(run.wiki ?? {}), root: result.wikiRoot, stagedAt: new Date().toISOString() };
          writeRun(run);
          return {
            ...result,
            next: {
              tool: 'wos_wiki_index',
              args: { runId: run.runId },
              reason: 'raw 就绪：按 SCHEMA 建 paper 页（每篇必建）+ entity 页（一作与通讯）+ concept 页，写完再重生成 index 并 lint',
            },
            guidance: guidance('wiki'),
          };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------- wiki lint
    {
      name: 'wos_wiki_lint',
      description:
        '全库体检：断链、孤儿页、index 漏登记、frontmatter 缺字段、标签不在白名单、出站链接不足 2、超 200 行、contested/低置信、raw 哈希漂移、日志轮转提醒，以及「扫描总数是否等于分层求和」（漏扫层的报警）。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          wikiRoot: { type: 'string', description: '知识库根目录；省略用账本记录的' },
        },
        [],
      ),
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const run = args?.dir || args?.runId ? readRun(runDirOf(resolved, args)) : null;
          const root = resolveWikiRoot(resolved, args, run);
          const report = wikiLint({ wikiRoot: root });
          return { ...report, layersExpected: LAYERS, guidance: guidance('wiki') };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------ wiki query
    {
      name: 'wos_wiki_query',
      description:
        '查知识库。mode:"search"（默认）按 text/tags/layer 检索页面，返回摘要、标签、置信度、来源与出站链接；mode:"page" 取单页全文 + 入链/出链；mode:"orient" 一次拿到 SCHEMA 的 Domain 与标签白名单、index、log 尾部——建页或改页前先 orient，避免重复建页与漏交叉引用。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          wikiRoot: { type: 'string', description: '知识库根目录；省略用账本记录的或默认位置' },
          mode: { type: 'string', enum: ['search', 'page', 'orient'], description: '默认 search' },
          slug: { type: 'string', description: 'mode=page 时的页面 slug（不带 .md）' },
          layer: {
            type: 'string',
            enum: ['papers', 'entities', 'concepts', 'comparisons', 'queries'],
            description: '限定某一层',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（需全部命中）' },
          text: { type: 'string', description: '关键词；命中标题的加权最高' },
          limit: { type: 'integer', description: '最多返回几条；默认 20，上限 200' },
          includeBody: { type: 'boolean', description: 'search 时是否附带全文；默认 false' },
          logLines: { type: 'integer', description: 'orient 模式下 log 取尾部几条；默认 30' },
        },
        [],
      ),
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const run = args?.dir || args?.runId ? readRun(runDirOf(resolved, args)) : null;
          const root = resolveWikiRoot(resolved, args, run);
          return wikiQuery({
            wikiRoot: root,
            mode: args?.mode === 'page' || args?.mode === 'orient' ? args.mode : 'search',
            slug: args?.slug,
            layer: args?.layer,
            tags: args?.tags,
            text: args?.text,
            limit: args?.limit,
            includeBody: args?.includeBody === true,
            logLines: args?.logLines,
          });
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ---------------------------------------------------------- wiki archive
    {
      name: 'wos_wiki_archive',
      description:
        '归档被取代的页面：移入 _archive/<日期>/<层>/，重生成 index 后不再计入分层。默认只预览（列出目标 + 入链告警），confirm:true 才真正移动。目标至少给 slugs / layers / olderThanDays 之一。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          wikiRoot: { type: 'string', description: '知识库根目录；省略用账本记录的' },
          slugs: { type: 'array', items: { type: 'string' }, description: '要归档的页面 slug' },
          layers: { type: 'array', items: { type: 'string' }, description: '按层归档（会整层清空，慎用）' },
          olderThanDays: { type: 'integer', description: '只归档 updated/created 早于 N 天的页' },
          reason: { type: 'string', description: '归档原因，会写进 log' },
          confirm: { type: 'boolean', description: 'true 才真的移动文件；缺省只预览' },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = args?.dir || args?.runId ? readRun(runDirOf(resolved, args)) : null;
          const root = resolveWikiRoot(resolved, args, run);
          return wikiArchive({
            wikiRoot: root,
            confirm: args?.confirm === true,
            slugs: args?.slugs,
            layers: args?.layers,
            olderThanDays: args?.olderThanDays,
            reason: args?.reason,
          });
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },

    // ------------------------------------------------------------ wiki index
    {
      name: 'wos_wiki_index',
      description:
        '重生成 index.md 与 _meta/BUILD_REPORT.md。层列表来自代码里的 LAYERS，五层全覆盖，不会因为写死目录而静默丢页。',
      parameters: OBJ(
        {
          ...RUN_SELECTOR,
          wikiRoot: { type: 'string', description: '知识库根目录；省略用账本记录的' },
        },
        [],
      ),
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const run = args?.dir || args?.runId ? readRun(runDirOf(resolved, args)) : null;
          const root = resolveWikiRoot(resolved, args, run);
          const result = wikiIndex({ wikiRoot: root, topic: run?.topic });
          return { ...result, guidance: guidance('wiki') };
        } catch (error) {
          fail(error);
        }
      },
      output: output({ type: 'object', properties: {} }),
    },
  ];
}
