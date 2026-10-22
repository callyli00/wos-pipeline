/**
 * 标识符生成：目录名与 runId。
 *
 * 保留汉字（主题通常是中文），其余非字母数字折叠成连字符。
 * 目录名是给人看的稳定标识，不是哈希。
 */

const CJK = '\u4e00-\u9fff';

export function slugify(text, maxLen = 28) {
  const normalized = String(text ?? '').normalize('NFKC');
  const kept = normalized.replace(new RegExp(`[^A-Za-z0-9${CJK}]+`, 'g'), '-');
  const trimmed = kept.replace(/^-+|-+$/g, '');
  if (!trimmed) return 'topic';
  return trimmed.slice(0, maxLen).replace(/-+$/g, '') || 'topic';
}

export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function makeRunId(topic, date = new Date()) {
  return `wos_${slugify(topic)}_${stamp(date)}`;
}
