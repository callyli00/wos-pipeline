/**
 * run.json → records.md 的渲染。
 *
 * records.md 是只读视图：人读它，模型不写它。所有写入都走 run.json，
 * 于是「四张表被行首前缀匹配一次改坏三张」这类事故在结构上不可能发生。
 */

const MARK = { ok: '✅', pending: '⬜', fail: '❌' };

function cell(value) {
  const text = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  return text || '—';
}

function status(value) {
  return MARK[value] ?? MARK.pending;
}

function doiCell(record) {
  return record.doi ? record.doi : 'no DOI';
}

export function renderRecordsMd(run) {
  const out = [];
  const gateN = run.gate.n ?? '待定';
  const gateLabel = run.gate.waived ? `waived（用户豁免：${run.gate.waivedReason ?? '未写理由'}）` : run.gate.verdict;

  out.push(`# WOS 检索记录 — ${run.topic}`);
  out.push('');
  out.push('<!-- 由 run.json 生成，请勿手工编辑；写入请用 wos_records_update。 -->');
  out.push('');
  out.push(`- 检索式：${run.query}`);
  out.push(`- 数据库：${run.database}`);
  out.push(`- N（闸门值）：${gateN}　区间：${run.gate.min}–${run.gate.max}　判定：${gateLabel}`);
  out.push(`- 阶段：${run.stage}`);
  out.push(`- 开始时间 / 最后更新：${run.createdAt} / ${run.updatedAt}`);
  if (run.wiki?.root) out.push(`- 知识库：${run.wiki.root}`);
  out.push('');

  if (Array.isArray(run.attempts) && run.attempts.length > 0) {
    out.push('## 检索式迭代');
    out.push('| 轮 | N | 判定 | 检索式 | 备注 |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const attempt of run.attempts) {
      out.push(
        `| ${attempt.round} | ${cell(attempt.n)} | ${cell(attempt.verdict)} | ${cell(attempt.query)} | ${cell(attempt.note)} |`,
      );
    }
    out.push('');
  }

  out.push('## 进度');
  out.push('| # | 标题 | DOI | 状态 |');
  out.push('| --- | --- | --- | --- |');
  for (const record of run.records) {
    const done = record.ut ? 'ok' : 'pending';
    out.push(`| ${record.n} | ${cell(record.title)} | ${cell(doiCell(record))} | ${status(done)} |`);
  }
  out.push('');

  out.push('## 记录');
  for (const record of run.records) {
    out.push(`### ${record.n}. ${record.title || '(无标题)'}`);
    const authors = record.authorsFull.length ? record.authorsFull.join('; ') : record.authorsShort.join('; ');
    out.push(
      `- 作者：${cell(authors)}　/　DOI：${cell(doiCell(record))}　/　${record.year ?? '年份未知'}　/　${cell(record.journal)}`,
    );
    out.push('');
    out.push(record.abstract || '(无摘要)');
    out.push('');
  }

  out.push('## 分类');
  out.push('| # | 级别 | 一句话依据 | 主体体系 |');
  out.push('| --- | --- | --- | --- |');
  for (const record of run.records) {
    out.push(
      `| ${record.n} | ${cell(record.level)} | ${cell(record.levelBasis)} | ${cell(record.subjectSystem)} |`,
    );
  }
  out.push('');

  out.push('## 下载');
  out.push('| # | 出版商 | 文件名 | 状态 | 失败原因 |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const record of run.records) {
    out.push(
      `| ${record.n} | ${cell(record.publisher)} | ${cell(record.download.file)} | ${status(record.download.status)} | ${cell(record.download.failReason)} |`,
    );
  }
  out.push('');

  out.push('## 解析');
  out.push('| # | full.md 路径 | 状态 | 失败原因 |');
  out.push('| --- | --- | --- | --- |');
  for (const record of run.records) {
    out.push(
      `| ${record.n} | ${cell(record.parse.fullMd)} | ${status(record.parse.status)} | ${cell(record.parse.failReason)} |`,
    );
  }
  out.push('');

  return out.join('\n');
}
