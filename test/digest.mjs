/**
 * 生成分级用的紧凑清单：序号 / 年份 / 期刊 / 标题 / 摘要前 N 字。
 * 用法：node digest.mjs <run 目录> [摘要截断长度]
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const cap = Number(process.argv[3] ?? 260);
if (!dir) {
  console.error('需要 run 目录');
  process.exit(1);
}

const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
const lines = run.records.map((record) => {
  const title = String(record.title ?? '').replace(/\s+/g, ' ').trim();
  const abs = String(record.abstract ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
  return [record.n, record.year ?? '', record.j9 || record.journal || '', title, abs].join('\t');
});

const out = path.join(dir, '_grading_digest.tsv');
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`已写出 ${lines.length} 行 → ${out}`);
console.log(`总字节：${fs.statSync(out).size}`);
