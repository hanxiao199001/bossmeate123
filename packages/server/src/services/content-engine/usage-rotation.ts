/**
 * 7-03 图文模板重构④：批次内用量轮换计数器（治"全员闭眼冲"）。
 *
 * 问题：同一批次 10 篇文章，钩子模式/标题狠话全靠随机 → 实测容易 7 篇都是"结果前置+闭眼冲"。
 * 方案：进程内按「天 + scope」维护用量计数，scope = batchId（批量路径）或 accountId（单号路径），
 *       每个 key（钩子模式名/标题措辞）在同一 scope 当天限用 N 次，用满后：
 *       - 服务端选择型（article-skill 正文钩子）：直接从候选里剔除
 *       - LLM 选择型（format-generators 钩子块 / title-generator 措辞）：注入"已用满禁选"清单
 *
 * 刻意用内存不落库：batch-worker 单进程消费，天级 key 自动换代；进程重启丢计数可接受
 * （最坏退化回旧随机行为，不影响正确性）。
 */

/** dayKey|scope -> key -> count */
const counters = new Map<string, Map<string, number>>();

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function scopeMap(scope: string): Map<string, number> {
  const day = dayKey();
  const mapKey = `${day}|${scope}`;
  // 换天惰性清理：把非当天的计数全部丢掉，防 Map 无限增长
  for (const k of counters.keys()) {
    if (!k.startsWith(`${day}|`)) counters.delete(k);
  }
  let m = counters.get(mapKey);
  if (!m) {
    m = new Map();
    counters.set(mapKey, m);
  }
  return m;
}

/** 记一次使用 */
export function recordUsage(scope: string, key: string): void {
  if (!scope || !key) return;
  const m = scopeMap(scope);
  m.set(key, (m.get(key) ?? 0) + 1);
}

/** 当天该 scope 下 key 已用几次 */
export function usageCount(scope: string, key: string): number {
  if (!scope || !key) return 0;
  return scopeMap(scope).get(key) ?? 0;
}

/** keys 里已达 limit 的（供注入"禁选"清单 / 候选剔除） */
export function exhaustedKeys(scope: string, keys: string[], limit: number): string[] {
  if (!scope) return [];
  return keys.filter((k) => usageCount(scope, k) >= limit);
}

/** 测试用：清空全部计数 */
export function resetUsageCounters(): void {
  counters.clear();
}
