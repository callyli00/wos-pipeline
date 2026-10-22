/**
 * wos-pipeline 的 Host 半边。
 *
 * 只做一件事：把 WOS 检索过程变成一本有类型的账本（run.json），
 * 用工具取代「模型手写 Markdown 表」。浏览器、PDF 解析与知识库内容由外部执行手承担，
 * 本插件不代做下载，也不起后台进程。
 *
 * @module wos-pipeline
 */

import { resolveConfig } from './lib/config.js';
import { createTools } from './lib/tools.js';

export const name = 'wos-pipeline';

/** Cordis 先等工具注册表就绪，再 apply 本插件。 */
export const inject = ['tools'];

export { ConfigError, resolveConfig } from './lib/config.js';
export { createTools } from './lib/tools.js';

/**
 * 工具返回值必须是 lossless JSON：`undefined` / NaN / 函数都会让 host 判定为有损，
 * 表现为「tool returned invalid output」。这里统一过一遍 JSON 往返做兜底，
 * 真正的源头修复仍然在各工具里（不要靠这层擦屁股）。
 */
function lossless(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return { error: `工具返回值无法序列化为 JSON：${String(error)}` };
  }
}

/**
 * @param {object} ctx - 已注入 `ctx.tools` 的 Cordis 上下文
 * @param {object} config - patch 里这一行的 `config`；在这里校验，写错就在加载期失败
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const definitions = createTools(resolved).map((definition) => ({
    ...definition,
    async execute(args, context) {
      return lossless(await definition.execute(args, context));
    },
  }));
  for (const definition of definitions) {
    ctx.tools.register(definition);
  }
  ctx.logger?.info(`wos-pipeline: registered ${definitions.map((d) => d.name).join(', ')}`);
}
