/**
 * 阶段判据的按需加载。
 *
 * 判据不常驻上下文：wos_run_status 只返回当前阶段那一节（约 150–250 token），
 * 其余阶段不出现。这是「删掉 65KB skill 仍不丢经验」的实现方式。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = new URL('../data/playbook/', import.meta.url);

function read(name) {
  try {
    return fs.readFileSync(fileURLToPath(new URL(name, BASE)), 'utf8').trim();
  } catch {
    return '';
  }
}

export function guidance(stage) {
  return read(`${stage}.md`) || read('stage-unknown.md');
}

export function discipline() {
  return read('discipline.md');
}
