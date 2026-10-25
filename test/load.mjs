/**
 * 加载测试：模拟 host 的 tools 服务，验证 apply() 注册出全部工具且契约形状合法。
 * 同时用真实账本验证 schema v1 → v2 迁移。
 */

import path from 'node:path';
import fs from 'node:fs';

import { apply, name } from '../index.js';
import { readRun } from '../lib/run.js';

const registered = [];
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  logger: { info: () => {} },
};

apply(ctx, { runsRoot: '', gate: { min: 50, max: 300, maxAttempts: 3 }, pageSize: 20, wikiRoot: '' });

let bad = 0;
for (const definition of registered) {
  const problems = [];
  if (typeof definition.name !== 'string' || !definition.name.startsWith('wos_')) problems.push('name');
  if (typeof definition.description !== 'string' || definition.description.length < 20) problems.push('description');
  if (!definition.parameters || definition.parameters.type !== 'object') problems.push('parameters');
  if (typeof definition.execute !== 'function') problems.push('execute');
  if (!definition.output || typeof definition.output.render !== 'function' || !definition.output.schema) problems.push('output');
  if (problems.length > 0) {
    bad += 1;
    console.log(`  FAIL ${definition.name}: 缺 ${problems.join(', ')}`);
  }
}

const names = registered.map((definition) => definition.name);
console.log(`插件名：${name}`);
console.log(`注册工具 ${registered.length} 个：`);
for (const toolName of names) console.log(`  - ${toolName}`);
const dupes = names.filter((toolName, index) => names.indexOf(toolName) !== index);
console.log(`契约校验：${bad === 0 ? 'ok' : `${bad} 个不合法`}，重名：${dupes.length === 0 ? '无' : dupes.join(', ')}`);

const expected = [
  'wos_run_create',
  'wos_run_status',
  'wos_import_records',
  'wos_query_revise',
  'wos_records_query',
  'wos_records_update',
  'wos_download_plan',
  'wos_pdf_intake',
  'wos_browser_hygiene',
  'wos_human_verify',
  'wos_download_audit',
  'wos_parse_plan',
  'wos_parse_audit',
  'wos_wiki_init',
  'wos_wiki_stage_raw',
  'wos_wiki_lint',
  'wos_wiki_query',
  'wos_wiki_archive',
  'wos_wiki_index',
];
const missing = expected.filter((toolName) => !names.includes(toolName));
console.log(`期望 ${expected.length} 个工具，缺失：${missing.length === 0 ? '无' : missing.join(', ')}`);
console.log(`实际注册 ${names.length} 个：${names.length === expected.length ? '数量一致' : `数量不符（${names.length} vs ${expected.length}）`}`);

// 真实账本迁移（v1 → v2）：可选，用 WOS_TEST_RUN 指定，默认跳过
const realRun = process.env.WOS_TEST_RUN ?? '';
if (realRun && fs.existsSync(path.join(realRun, 'run.json'))) {
  const run = readRun(realRun);
  console.log(`\n真实账本迁移：schemaVersion=${run.schemaVersion} stage=${run.stage} records=${run.records.length}`);
  console.log(`  attempts=${JSON.stringify(run.attempts)}`);
  console.log(`  gate=${JSON.stringify(run.gate)}`);
  console.log(`  首条 publisher=${JSON.stringify(run.records[0]?.publisher)} parse.provider=${JSON.stringify(run.records[0]?.parse?.provider)}`);
} else {
  console.log('\n（真实账本不在预期路径，跳过迁移检查）');
}

process.exitCode = bad === 0 && missing.length === 0 ? 0 : 1;
