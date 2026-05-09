/**
 * P3 AI 推荐 cache（5-10 backend Day 1）。
 *
 * 30 分钟 TTL in-memory Map。key 含 tenantId 防 cross-tenant 污染。
 * spec：防 LLM 频繁调用（user 反复打开选刊 modal 时）。
 */

const TTL_MS = 30 * 60 * 1000;

interface Entry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

export function cacheKey(parts: Array<string | number | undefined>): string {
  return parts.filter((p) => p !== undefined && p !== "").map(String).join(":");
}

export function cacheGet<T>(key: string): T | null {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    store.delete(key);
    return null;
  }
  return e.data;
}

export function cacheSet<T>(key: string, data: T): void {
  store.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

/** 测试用：手动清空 */
export function cacheClear(): void {
  store.clear();
}

/** 测试用：暴露当前 size 验证 */
export function cacheSize(): number {
  return store.size;
}
