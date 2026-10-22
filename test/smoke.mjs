/**
 * 端到端冒烟测试：不起浏览器，只测账本、闸门硬规则、收编、解析回填与 wiki 机械能力。
 * 运行：node test/smoke.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import {
  readRun,
  writeRun,
  createRun,
  applyPatch,
  syncStage,
  nextStep,
  counts,
  evaluateGate,
  recordAttempt,
  reviseQuery,
  waiveGate,
} from '../lib/run.js';
import { parseSavedrecs, dedupe, toLedgerRecords, canonicalPdfName } from '../lib/savedrecs.js';
import { downloadPlan, intakePdf, auditDownloads, pdfMagicOk, publisherOf } from '../lib/download.js';
import { parsePlan, parseAudit } from '../lib/parse.js';
import { wikiInit, stageRaw, wikiIndex, wikiLint, parseFrontmatter, countQuotedSources } from '../lib/wiki.js';

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectError(name, fn, code) {
  try {
    await fn();
    check(name, false, '本应抛错但成功了');
  } catch (error) {
    check(name, error.code === code || String(error.message).includes(code), `期望 ${code}，实际：${error.code ?? ''} ${error.message.slice(0, 80)}`);
  }
}

const SAVEDRECS = `FN Clarivate Analytics Web of Science
VR 1.0
PT J
AU Zhang, Wei
   Li, Na
AF Zhang, Wei
   Li, Na
TI Evaporation-induced self-assembly of silica nanoparticles into ordered mesoporous thin films
SO JOURNAL OF COLLOID AND INTERFACE SCIENCE
J9 J COLLOID INTERFACE SCI
PU ELSEVIER SCIENCE INC
PY 2023
DI 10.1016/j.jcis.2023.000001
AB Ordered mesoporous silica thin films were prepared by evaporation-induced self-assembly of silica nanoparticles with a triblock copolymer template. The films show uniform mesopores.
TC 12
DT Article
UT WOS:000000000000001
ER

PT J
AU Wang, Lei
AF Wang, Lei
TI Drying-mediated self-assembly of colloidal nanoparticles at the meniscus
SO LANGMUIR
J9 LANGMUIR
PU AMER CHEMICAL SOC
PY 2021
DI 10.1021/acs.langmuir.1c00002
AB Drying-mediated self-assembly of colloidal nanoparticles is studied. Coffee ring formation and convective assembly are analysed.
TC 5
DT Article
UT WOS:000000000000002
ER

PT J
AU Chen, Hui
AF Chen, Hui
TI Evaporation induced self assembly of block copolymer templated mesoporous titania films
SO CHEMISTRY OF MATERIALS
J9 CHEM MATER
PU AMER CHEMICAL SOC
PY 2020
DI 10.1021/acs.chemmater.0c00003
AB Mesoporous titania films via evaporation induced self assembly. No DOI case tested separately.
TC 40
DT Review
UT WOS:000000000000003
ER

EF
`;

function fakePdf(bytes = 26000) {
  const head = '%PDF-1.7\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(bytes - head.length, 0x20)]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-smoke-'));
  const srcDir = path.join(root, '_source');
  fs.mkdirSync(srcDir, { recursive: true });
  const savedrecs = path.join(srcDir, 'savedrecs.txt');
  fs.writeFileSync(savedrecs, SAVEDRECS, 'utf8');

  console.log('\n[1] 配置与解析');
  const resolved = resolveConfig({ runsRoot: root, gate: { min: 1, max: 2, maxAttempts: 3 }, pageSize: 20 });
  check('resolveConfig 默认值', resolved.gate.maxAttempts === 3 && resolved.pageSize === 20);
  await expectError('非法 gate 被拒', async () => resolveConfig({ gate: { min: 300, max: 50 } }), '配置无效');

  const parsed = parseSavedrecs(SAVEDRECS);
  check('解析出 3 条记录', parsed.length === 3, `实际 ${parsed.length}`);
  check('读到 PU 出版商', parsed[0].publisher === 'ELSEVIER SCIENCE INC', parsed[0].publisher);
  const { records: unique, dropped } = dedupe(parsed);
  check('去重无损失', dropped === 0 && unique.length === 3);
  const ledger = toLedgerRecords(unique);
  check('序号从 1 起', ledger[0].n === 1 && ledger[2].n === 3);
  check('规范文件名由 TI/J9/PY 生成', canonicalPdfName(ledger[0]) === '001_JCOLLOIDINTERFACESCI_2023_Evaporation_induced_self_assembly_silica.pdf', canonicalPdfName(ledger[0]));
  check('出版商分组识别', publisherOf(ledger[0]) === 'Elsevier' && publisherOf(ledger[1]) === 'ACS', `${publisherOf(ledger[0])}/${publisherOf(ledger[1])}`);

  console.log('\n[2] 建 run 与闸门硬规则');
  const { run, created } = createRun({
    root,
    topic: '冒烟测试 蒸发自组装',
    query: 'TS=(evaporation-induced self-assembly)',
    gate: resolved.gate,
    maxAttempts: resolved.gate.maxAttempts,
  });
  check('建 run 成功', created && fs.existsSync(path.join(run.dir, 'run.json')));
  check('初始 stage=created', run.stage === 'created');

  // 直接模拟 import 的核心逻辑（工具层，绕过 schema 校验部分）
  const simulateImport = ({ query, acceptOutOfRange, acceptReason }) => {
    const live = readRun(run.dir);
    if (query !== live.query) {
      const error = new Error(`导入的检索式与账本记录的不一致 [QUERY_CHANGED_UNCONFIRMED]`);
      throw error;
    }
    live.records = toLedgerRecords(unique);
    const gate = evaluateGate(live, live.records.length);
    const attempt = recordAttempt(live, { query: live.query, n: live.records.length, verdict: gate.verdict });
    if (gate.verdict !== 'passed' && acceptOutOfRange) waiveGate(live, acceptReason);
    live.stage = live.gate.verdict === 'passed' || live.gate.verdict === 'waived' ? 'imported' : 'created';
    syncStage(live);
    writeRun(live);
    return { gate, attempt, run: live };
  };

  await expectError(
    '换了检索式导入被拒',
    async () => simulateImport({ query: 'TS=(self-assembly)' }),
    'QUERY_CHANGED_UNCONFIRMED',
  );

  const first = simulateImport({ query: 'TS=(evaporation-induced self-assembly)' });
  check('3 条 > 上限 2 → too-wide', first.gate.verdict === 'too-wide', first.gate.verdict);
  check('闸门要求与用户交互', first.gate.needsUserInteraction === true);
  check('记录第 1 轮历史', first.run.attempts.length === 1 && first.run.attempts[0].n === 3);
  check('闸门未过时 stage 停在 created', first.run.stage === 'created');
  const step = nextStep(first.run);
  check('next 指向 wos_query_revise 且标记需交互', step.tool === 'wos_query_revise' && step.requiresUserInteraction === true, step.tool);

  console.log('\n[3] 检索式修订必须用户确认');
  await expectError(
    '未确认的修订被拒',
    async () => {
      const live = readRun(run.dir);
      reviseQuery(live, { query: 'TS=(narrower)', confirmedByUser: false });
    },
    'QUERY_NOT_CONFIRMED',
  );
  {
    const live = readRun(run.dir);
    const change = reviseQuery(live, { query: 'TS=(evaporation-induced self-assembly) AND TS=(silica)', confirmedByUser: true });
    writeRun(live);
    check('确认后修订成功', change.after.includes('silica') && readRun(run.dir).query.includes('silica'));
  }

  console.log('\n[4] 用户豁免闸门');
  {
    const live = readRun(run.dir);
    // 把 query 改回，模拟用户最终决定「就收这 3 条」
    live.query = 'TS=(evaporation-induced self-assembly)';
    writeRun(live);
    const result = simulateImport({ query: 'TS=(evaporation-induced self-assembly)', acceptOutOfRange: true, acceptReason: '用户明确接受 3 条' });
    check('豁免后 gate.verdict=waived', result.run.gate.verdict === 'waived', result.run.gate.verdict);
    check('豁免理由落账', String(result.run.gate.waivedReason).includes('用户明确接受'));
    check('豁免后 stage=imported', result.run.stage === 'imported', result.run.stage);
  }

  console.log('\n[5] 分级 → 梯度 → 下载计划');
  {
    const live = readRun(run.dir);
    applyPatch(live, [
      { n: 1, level: '高', levelBasis: '直接给出 EISA 介孔膜数据', subjectSystem: 'silica' },
      { n: 2, level: '中', levelBasis: '只讨论机理未给膜结构', subjectSystem: 'colloid' },
      { n: 3, level: '低', levelBasis: '综述顺带提及', subjectSystem: 'titania' },
    ]);
    syncStage(live);
    check('全部分级后 stage=classified', live.stage === 'classified', live.stage);
    applyPatch(live, null, { selected: ['high', 'mid'] });
    syncStage(live);
    writeRun(live);
    check('选梯度后 stage=downloading', readRun(run.dir).stage === 'downloading', readRun(run.dir).stage);

    const plan = downloadPlan(readRun(run.dir), { groupBy: 'publisher' });
    check('计划里只有高/中两条', plan.total === 2, String(plan.total));
    check('按出版商分组', plan.groups.length === 2 && plan.groups.every((group) => group.pdfHint), JSON.stringify(plan.groups.map((g) => g.key)));
    check('每组带 DOI 链接与规范名', plan.groups[0].records[0].doiUrl.startsWith('https://doi.org/'));
  }

  console.log('\n[6] PDF 收编');
  {
    const live = readRun(run.dir);
    const good = path.join(srcDir, 'downloaded-good.pdf');
    fs.writeFileSync(good, fakePdf());
    const result = intakePdf(live, { n: 1, sourcePath: good });
    writeRun(live);
    check('合法 PDF 收编成功', result.ok === true, result.reason);
    check('移入 downloads/ 且改名', fs.existsSync(path.join(live.dir, 'downloads', result.file)), result.file);
    check('源文件已移走', !fs.existsSync(good));

    const shell = path.join(srcDir, 'html-shell.pdf');
    fs.writeFileSync(shell, Buffer.from('<html><body>Access denied</body></html>', 'utf8'));
    const live2 = readRun(run.dir);
    const bad = intakePdf(live2, { n: 2, sourcePath: shell });
    writeRun(live2);
    check('HTML 壳判 fail', bad.ok === false && String(bad.reason).includes('HTML'), bad.reason);

    const tiny = path.join(srcDir, 'tiny.pdf');
    fs.writeFileSync(tiny, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]));
    const live3 = readRun(run.dir);
    const small = intakePdf(live3, { n: 2, sourcePath: tiny });
    writeRun(live3);
    check('过小文件判 fail', small.ok === false && String(small.reason).includes('过小'), small.reason);

    const audit = auditDownloads(readRun(run.dir), {});
    check('审计：✅ 数与文件数一致', audit.markedOk === 1 && audit.pdfFiles === 1, `${audit.markedOk}/${audit.pdfFiles}`);
    check('审计：无缺失无损坏', audit.missing.length === 0 && audit.corrupt.length === 0);
    check('%PDF- 探测可靠', pdfMagicOk(path.join(live.dir, 'downloads', result.file)) === true);
  }

  console.log('\n[7] 解析回填');
  {
    const live = readRun(run.dir);
    const record = live.records[0];
    const stem = record.download.file.replace(/\.pdf$/i, '');
    const dir = path.join(live.dir, 'downloads', stem);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'full.md'), '# 全文\n\n蒸发诱导自组装制备有序介孔二氧化硅薄膜。\n', 'utf8');

    const plan = parsePlan(live, {});
    check('解析计划含待解析项', plan.total >= 1, String(plan.total));
    check('计划给出可照抄调用', plan.items[0].steps[0].tool === 'async_parse_pdf');

    const dry = parseAudit(live, { apply: false });
    check('dry-run 不写账本', readRun(run.dir).records[0].parse.status === 'pending' && dry.found === 1);
    const live4 = readRun(run.dir);
    const applied = parseAudit(live4, { apply: true });
    writeRun(live4);
    check('apply 后回填 full.md', applied.applied === true && readRun(run.dir).records[0].parse.status === 'ok');
  }

  console.log('\n[8] wiki 机械能力');
  {
    const live = readRun(run.dir);
    const wikiRoot = path.join(root, 'LLM_WiKi_KnowledgeBase');
    const init = wikiInit({ wikiRoot, topic: live.topic, tags: ['paper', 'self-assembly'], records: live.records });
    check('骨架含五层', ['papers', 'entities', 'concepts', 'comparisons', 'queries'].every((layer) => fs.existsSync(path.join(wikiRoot, layer))));
    check('SCHEMA 有标签代码块', fs.readFileSync(path.join(wikiRoot, 'SCHEMA.md'), 'utf8').includes('```yaml tags'));
    check('PROCESS 预填记录行', fs.readFileSync(path.join(wikiRoot, '_meta', 'PROCESS.md'), 'utf8').split('\n').filter((line) => line.startsWith('| 1 |')).length === 1);
    check('papers/README 不带 wikilink', !fs.readFileSync(path.join(wikiRoot, 'papers', 'README.md'), 'utf8').includes('[['));

    const staged = stageRaw({ wikiRoot, run: live });
    check('raw 落位 1 篇', staged.staged === 1, JSON.stringify(staged));
    const again = stageRaw({ wikiRoot, run: live });
    check('重跑按 sha256 跳过', again.staged === 0 && again.skipped === 1, `staged=${again.staged} skipped=${again.skipped}`);
    const rawFull = path.join(wikiRoot, staged.items[0].rawDir, 'full.md');
    const rawText = fs.readFileSync(rawFull, 'utf8');
    check('raw frontmatter 有 source_url', rawText.includes('source_url: "https://doi.org/'));
    check('sources 引号计数函数可用', countQuotedSources('sources: ["a, b", "c"]') === 2);

    // 造两个页：一个合规、一个故意缺字段/断链
    fs.writeFileSync(path.join(wikiRoot, 'papers', 'good-page.md'), [
      '---',
      'title: "合规页"',
      'created: 2026-10-22',
      'updated: 2026-10-22',
      'type: paper',
      'tags: [paper, self-assembly]',
      'sources: ["raw/papers/x/full.md"]',
      '---',
      '',
      '内容，链到 [[another-page]] 与 [[concept-x]]。',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(wikiRoot, 'concepts', 'another-page.md'), '---\ntitle: "另一页"\ncreated: 2026-10-22\nupdated: 2026-10-22\ntype: concept\ntags: [paper]\nsources: ["raw/papers/y/full.md"]\n---\n\n链回 [[good-page]] 与 [[concept-x]]。\n', 'utf8');
    fs.writeFileSync(path.join(wikiRoot, 'concepts', 'concept-x.md'), '---\ntitle: "概念X"\ncreated: 2026-10-22\nupdated: 2026-10-22\ntype: concept\ntags: [not-in-taxonomy]\nsources: ["raw/papers/z/full.md"]\n---\n\n链 [[good-page]] 与 [[another-page]] 与 [[does-not-exist]]。\n', 'utf8');

    const index = wikiIndex({ wikiRoot, topic: live.topic });
    check('index 覆盖五层', index.layers.length === 5, JSON.stringify(index.layers));
    check('index 一致性校验通过', index.consistent === true);
    const indexText = fs.readFileSync(path.join(wikiRoot, 'index.md'), 'utf8');
    check('index 收录了 comparisons 层标题', indexText.includes('## comparisons'));

    const lint = wikiLint({ wikiRoot });
    check('lint 抓到断链', lint.issues.brokenLinks.some((item) => item.link === 'does-not-exist'), JSON.stringify(lint.issues.brokenLinks));
    check('lint 抓到非白名单标签', lint.issues.badTags.length === 1, JSON.stringify(lint.issues.badTags));
    check('lint 层覆盖一致', lint.coverageConsistent === true);
    check('lint 结论 needs-work', lint.verdict === 'needs-work', lint.verdict);
  }

  console.log('\n[9] 阶段推进与 records.md');
  {
    const live = readRun(run.dir);
    syncStage(live);
    writeRun(live);
    const md = fs.readFileSync(path.join(live.dir, 'records.md'), 'utf8');
    check('records.md 有检索式迭代表', md.includes('## 检索式迭代'));
    check('records.md 有豁免标记', md.includes('waived'));
    check('records.md 下载表含出版商列', md.includes('| 出版商 |'));
    const tally = counts(readRun(run.dir));
    check('计数：1 ok / 1 fail 下载', tally.download.ok === 1 && tally.download.fail === 1, JSON.stringify(tally.download));
    check('计数：1 条解析完成', tally.parse.ok === 1, JSON.stringify(tally.parse));
  }

  console.log('\n[10] 返回值必须是 lossless JSON（host 会校验，undefined/NaN 会报 invalid output）');
  {
    const scan = (value, trail = '$', found = []) => {
      if (value === undefined) found.push(`${trail}=undefined`);
      else if (typeof value === 'function') found.push(`${trail}=function`);
      else if (typeof value === 'number' && !Number.isFinite(value)) found.push(`${trail}=${value}`);
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) scan(item, `${trail}.${key}`, found);
      }
      return found;
    };

    const base = readRun(run.dir);
    const stages = ['created', 'imported', 'classified', 'downloading', 'downloaded', 'parsed', 'wiki'];
    const variants = stages.map((stage) => {
      const clone = JSON.parse(JSON.stringify(base));
      clone.stage = stage;
      return { label: stage, out: nextStep(clone) };
    });

    const wide = JSON.parse(JSON.stringify(base));
    wide.stage = 'created';
    wide.gate = { ...wide.gate, verdict: 'too-wide', n: 652, awaitingUser: true, capReached: false };
    wide.attempts = [{ round: 1, query: 'x', n: 652, verdict: 'too-wide', at: '2026-01-01T00:00:00.000Z' }];
    variants.push({ label: 'created/too-wide', out: nextStep(wide) });

    const capped = JSON.parse(JSON.stringify(wide));
    capped.gate.capReached = true;
    capped.attempts = [1, 2, 3].map((round) => ({ round, query: 'x', n: 100 + round, verdict: 'too-wide', at: '2026-01-01T00:00:00.000Z' }));
    variants.push({ label: 'created/cap-reached', out: nextStep(capped) });

    for (const { label, out } of variants) {
      const bad = scan(out);
      check(`nextStep(${label}) 无 undefined/NaN`, bad.length === 0, bad.join(', '));
    }
    check('cap 分支带 userDecided', nextStep(capped).args.userDecided === true);
    check('未到 cap 时 args 不含 userDecided 键', !('userDecided' in nextStep(wide).args));
  }

  console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
  if (failures.length > 0) {
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
  }
  console.log(`临时目录：${root}`);
}

main().catch((error) => {
  console.error('测试崩溃：', error);
  process.exitCode = 2;
});
