/**
 * 工具层执行测试：绕过 host，直接调 createTools 出来的 execute，
 * 用真实账本目录验证返回值形态（lossless JSON）与硬规则。
 * 运行：node test/tools-exec.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { createTools } from '../lib/tools.js';
import { wikiInit } from '../lib/wiki.js';

/**
 * 可选：指向一个真实 run 目录来跑回归（默认不用，改用临时 run，不会碰任何真实账本）。
 * 用法：WOS_TEST_RUN=/path/to/wos_xxx_20260101 npm run test:tools
 */
const REAL_RUN = process.env.WOS_TEST_RUN ?? '';

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

function scan(value, trail = '$', found = []) {
  if (value === undefined) found.push(`${trail}=undefined`);
  else if (typeof value === 'function') found.push(`${trail}=function`);
  else if (typeof value === 'number' && !Number.isFinite(value)) found.push(`${trail}=${value}`);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scan(item, `${trail}.${key}`, found);
  }
  return found;
}

async function main() {
  const resolved = resolveConfig({ gate: { min: 50, max: 300, maxAttempts: 3 }, pageSize: 20 });
  const tools = new Map(createTools(resolved).map((definition) => [definition.name, definition]));
  const call = (name, args) => tools.get(name).execute(args, {});

  const runDir = fs.existsSync(REAL_RUN) ? REAL_RUN : null;
  console.log(`真实账本：${runDir ?? '（不存在，改用临时 run）'}`);

  let dir = runDir;
  let tmpRoot = null;
  if (!dir) {
    const { createRun } = await import('../lib/run.js');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-tools-'));
    dir = createRun({
      root: tmpRoot,
      topic: '工具层测试',
      query: 'TS=(x)',
      gate: { min: 1, max: 2, maxAttempts: 3 },
    }).run.dir;
  }

  console.log('\n[1] 只读工具在真实账本上必须返回 lossless JSON');
  const status = await call('wos_run_status', { dir, verifyDisk: false });
  check('wos_run_status 不报 invalid output', scan(status).length === 0, scan(status).join(', '));
  check('status 带 attempts 数组', Array.isArray(status.attempts));
  check('status 带 gate 对象', Boolean(status.gate) && typeof status.gate.verdict === 'string');
  check('status 带 next.tool', typeof status.next?.tool === 'string' || status.next?.tool === null);

  const plan = await call('wos_download_plan', { dir });
  check('wos_download_plan 正常', scan(plan).length === 0 && Array.isArray(plan.groups), scan(plan).join(', '));

  const parsePlanOut = await call('wos_parse_plan', { dir });
  check('wos_parse_plan 正常', scan(parsePlanOut).length === 0 && typeof parsePlanOut.total === 'number', scan(parsePlanOut).join(', '));

  const audit = await call('wos_download_audit', { dir });
  check('wos_download_audit 正常', scan(audit).length === 0 && typeof audit.pdfFiles === 'number', scan(audit).join(', '));

  const parseAuditOut = await call('wos_parse_audit', { dir });
  check('wos_parse_audit 正常', scan(parseAuditOut).length === 0 && parseAuditOut.applied === false, scan(parseAuditOut).join(', '));

  console.log('\n[2] 闸门硬规则在工具层生效');
  try {
    await call('wos_query_revise', { dir, query: 'TS=(y)', confirmedByUser: false });
    check('未确认的修订被拒', false, '居然通过了');
  } catch (error) {
    check('未确认的修订被拒', String(error.message).includes('QUERY_NOT_CONFIRMED'), error.message.slice(0, 60));
  }

  try {
    await call('wos_import_records', { dir, path: path.join(os.tmpdir(), 'nope.txt'), query: 'TS=(z)' });
    check('不一致的导入被拒', false, '居然通过了');
  } catch (error) {
    // 文件不存在会先报 IMPORT_FILE_MISSING，两者都说明校验链在工作
    check('不一致的导入被拒（先撞文件检查）', /IMPORT_FILE_MISSING|QUERY_CHANGED_UNCONFIRMED/.test(error.message), error.message.slice(0, 60));
  }

  console.log('\n[3] wiki 工具');
  // 这一段会写 run.wiki / records.md：先备份，跑完复原，避免污染真实账本
  const runJsonPath = path.join(dir, 'run.json');
  const mdPath = path.join(dir, 'records.md');
  const backupJson = fs.existsSync(runJsonPath) ? fs.readFileSync(runJsonPath, 'utf8') : null;
  const backupMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
  const wikiRoot = path.join(tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wos-wiki-')), 'LLM_WiKi_KnowledgeBase');

  // 不带 confirm 必须是纯预览：给出路径、标记需确认、且一个文件都不写
  const preview = await call('wos_wiki_init', { dir, wikiRoot });
  check('wos_wiki_init 默认只预览', preview.mode === 'preview' && preview.requiresUserConfirmation === true, JSON.stringify(preview.mode));
  check('预览回显绝对路径', preview.wikiRoot === path.resolve(wikiRoot), preview.wikiRoot);
  check('预览不落盘', !fs.existsSync(path.join(wikiRoot, 'SCHEMA.md')));

  // 默认位置必须是任务目录内（要在账本还没记录 wiki 路径时检查）
  const defaultPreview = await call('wos_wiki_init', { dir });
  check('默认 wikiRoot 在任务目录内', path.resolve(defaultPreview.wikiRoot).toLowerCase() === path.resolve(dir, 'LLM_WiKi_KnowledgeBase').toLowerCase(), defaultPreview.wikiRoot);

  const initOut = await call('wos_wiki_init', { dir, wikiRoot, confirm: true });
  check('confirm 后真正创建', scan(initOut).length === 0 && fs.existsSync(path.join(wikiRoot, 'SCHEMA.md')), scan(initOut).join(', '));

  try {
    await call('wos_wiki_stage_raw', { dir, wikiRoot: path.join(wikiRoot, 'nope') });
    check('未初始化的路径拒收 raw', false, '居然通过了');
  } catch (error) {
    check('未初始化的路径拒收 raw', String(error.message).includes('WIKI_NOT_INITIALIZED'), error.message.slice(0, 60));
  }

  const indexOut = await call('wos_wiki_index', { wikiRoot });
  check('wos_wiki_index 正常', scan(indexOut).length === 0 && indexOut.consistent === true, scan(indexOut).join(', '));
  const lintOut = await call('wos_wiki_lint', { wikiRoot });
  check('wos_wiki_lint 正常', scan(lintOut).length === 0 && lintOut.coverageConsistent === true, scan(lintOut).join(', '));

  console.log('\n[5] 浏览器作业守卫：忘关 tab / 忘交人验证会被拦住');

  // 人机验证：没给正向判据必须拒绝
  try {
    await call('wos_human_verify', { dir, reason: 'Cloudflare' });
    check('没给正向判据时拒绝交接', false, '居然通过了');
  } catch (error) {
    check('没给正向判据时拒绝交接', String(error.message).includes('CRITERIA_REQUIRED'), error.message.slice(0, 70));
  }

  // 给正向判据 → 生成 bsk_assist 调用，并挡住下载计划
  const verifyPrepare = await call('wos_human_verify', { dir, reason: 'Cloudflare', titleText: 'Coffee-ring suppression' });
  check('交接返回 bsk_assist 调用', verifyPrepare.bskAssistCall?.action === 'request-help', JSON.stringify(verifyPrepare.bskAssistCall?.action));
  check('判据是正向信号', JSON.stringify(verifyPrepare.bskAssistCall.completionCriteria).includes('textExists'));
  check('交接带 mustDoNow 提示', Array.isArray(verifyPrepare.mustDoNow) && verifyPrepare.mustDoNow.length > 0);
  check('交接结果 lossless', scan(verifyPrepare).length === 0, scan(verifyPrepare).join(', '));

  const blockedPlan = await call('wos_download_plan', { dir });
  check('验证未收口时下载计划被拦', blockedPlan.blocked === true && blockedPlan.plan === null, JSON.stringify(blockedPlan.blocked));
  check('拦住时指向 wos_human_verify', blockedPlan.requiredTool === 'wos_human_verify', blockedPlan.requiredTool);
  check('拦住时要求用户交互', blockedPlan.requiresUserInteraction === true);
  check('拦住结果 lossless', scan(blockedPlan).length === 0, scan(blockedPlan).join(', '));

  // 收口后放行
  const verifyResolved = await call('wos_human_verify', { dir, resolved: true, outcome: 'passed' });
  check('收口后 gate 不 pending', verifyResolved.gate?.pending === false, JSON.stringify(verifyResolved.gate?.pending));
  const afterResolve = await call('wos_download_plan', { dir });
  check('收口后下载计划恢复', afterResolve.blocked !== true && Array.isArray(afterResolve.groups), JSON.stringify(afterResolve.blocked));

  // tab 自检：数量不为 1 必须拒绝
  const badHygiene = await call('wos_browser_hygiene', { dir, agentTabCount: 3 });
  check('agentTabCount>1 上报被拒', badHygiene.ok === false && badHygiene.code === 'HYGIENE_TABS_REMAIN', badHygiene.code);
  check('被拒时给出 mustDoNow', Array.isArray(badHygiene.mustDoNow) && badHygiene.mustDoNow.length > 0);
  const noCount = await call('wos_browser_hygiene', { dir });
  check('缺 agentTabCount 时报参数错', noCount.ok === false && noCount.code === 'HYGIENE_COUNT_INVALID', noCount.code);

  const goodHygiene = await call('wos_browser_hygiene', { dir, agentTabCount: 1 });
  check('agentTabCount=1 上报通过', goodHygiene.ok === true && goodHygiene.agentTabCount === 1, goodHygiene.code ?? JSON.stringify(goodHygiene.ok));
  check('自检结果 lossless', scan(goodHygiene).length === 0, scan(goodHygiene).join(', '));

  // 复原真实账本（测试不该留下痕迹）
  if (backupJson) fs.writeFileSync(runJsonPath, backupJson, 'utf8');
  if (backupMd) fs.writeFileSync(mdPath, backupMd, 'utf8');

  console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
  if (failures.length > 0) {
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('测试崩溃：', error);
  process.exitCode = 2;
});
