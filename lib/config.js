/**
 * 插件配置：形状、默认值与加载期校验。
 *
 * 不导出一个 `Config` schema —— 与已装的 dsh-weknora 一致，用手写校验，
 * 这样 patch 写错时是「加载失败并列出问题」，而不是一个投影不完整的 schema。
 */

export const DEFAULT_CONFIG = {
  /** 空 = 由工具参数决定，最后回落 Host 进程当前目录。 */
  runsRoot: '',
  gate: { min: 50, max: 300, maxAttempts: 3 },
  /** wos_records_query 的默认页大小。 */
  pageSize: 20,
  /** 空 = <任务目录>/LLM_WiKi_KnowledgeBase（建之前工具会先返回预览让用户确认）。 */
  wikiRoot: '',
};

/** patch 把插件配成它无法服务的形状时抛出。 */
export class ConfigError extends Error {
  constructor(violations) {
    super(`wos-pipeline 配置无效：\n  - ${violations.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function optionalDir(value, field, violations) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    violations.push(`${field} 必须是字符串`);
    return '';
  }
  return value.trim();
}

function intInRange(value, field, min, max, violations, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    violations.push(`${field} 必须是 ${min}–${max} 之间的数字，收到 ${JSON.stringify(value)}`);
    return fallback;
  }
  return Math.floor(value);
}

export function resolveConfig(raw) {
  const violations = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  const runsRoot = optionalDir(input.runsRoot, 'runsRoot', violations);
  const wikiRoot = optionalDir(input.wikiRoot, 'wikiRoot', violations);

  const gateInput = input.gate && typeof input.gate === 'object' ? input.gate : {};
  const min = intInRange(gateInput.min, 'gate.min', 1, 100000, violations, DEFAULT_CONFIG.gate.min);
  const max = intInRange(gateInput.max, 'gate.max', 1, 100000, violations, DEFAULT_CONFIG.gate.max);
  if (min > max) violations.push(`gate.min (${min}) 不能大于 gate.max (${max})`);
  const maxAttempts = intInRange(gateInput.maxAttempts, 'gate.maxAttempts', 1, 20, violations, DEFAULT_CONFIG.gate.maxAttempts);

  const pageSize = intInRange(input.pageSize, 'pageSize', 1, 50, violations, DEFAULT_CONFIG.pageSize);

  if (violations.length > 0) throw new ConfigError(violations);

  return { runsRoot, wikiRoot, gate: { min, max, maxAttempts }, pageSize };
}
