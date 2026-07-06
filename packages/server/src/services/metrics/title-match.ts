/**
 * 7-06 ① 效果回流 — 标题匹配纯函数层 (零 DB/env 依赖, 可直接单测)。
 *
 * 背景: 运营从公众号后台草稿箱手动群发的文章, 我们拿不到 msgid ↔ contentId 的硬关联,
 * 只能靠标题把 getarticlesummary 返回的每篇数据匹配回 contents。
 *
 * 匹配策略 (从严到宽, 匹配不上宁可不塞也不硬凑错数据):
 *   1. exact  — 去所有空白后完全相等 (运营原样群发, 最常见)
 *   2. fuzzy  — 前缀 20 字符相同 (运营只改了结尾/加了 emoji 后缀)
 *              或编辑距离 ≤ max(2, 10% 短标题长度) (小改几个字)
 *   3. null   — 都不中 → 调用方落"未匹配清单"日志
 */

/** 标题归一化: 去掉所有空白(含全角空格/零宽字符), 用于对比。不动其它字符, 中文标题大小写无关。 */
export function normalizeTitle(t: string | null | undefined): string {
  if (!t) return "";
  return t.replace(/[\s　​‌‍﻿]+/g, "").trim();
}

/**
 * 编辑距离 (Levenshtein), 带 maxDistance 提前退出 — 超过阈值直接返回 maxDistance+1,
 * 标题 ≤64 字节 (微信硬限) 所以 O(n·m) 完全够用。
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1; // 整行都超阈值, 不可能再降回来
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

export interface TitleMatchCandidate {
  contentId: string;
  title: string | null;
}

export interface TitleMatchResult {
  contentId: string;
  matchType: "exact" | "fuzzy";
  /** fuzzy 时的编辑距离 (prefix 命中记 -1 表示"前缀20字同") */
  distance?: number;
}

const FUZZY_PREFIX_LEN = 20;

/** fuzzy 编辑距离阈值: max(2, 10% 短标题长度) — 标题越长容忍越大, 但短标题最少也容 2 字差 */
export function fuzzyThreshold(lenA: number, lenB: number): number {
  return Math.max(2, Math.floor(Math.min(lenA, lenB) * 0.1));
}

/**
 * 把一篇公众号已发布文章(标题)匹配回我们的 contents 候选池。
 * exact 优先; fuzzy 取编辑距离最小者; 都不中返回 null (调用方记"未匹配清单", 别硬塞)。
 */
export function matchArticleToContent(
  publishedTitle: string,
  candidates: TitleMatchCandidate[],
): TitleMatchResult | null {
  const target = normalizeTitle(publishedTitle);
  if (!target) return null;

  // 1. 精确匹配 (去空白后全等)
  for (const c of candidates) {
    if (normalizeTitle(c.title) === target) {
      return { contentId: c.contentId, matchType: "exact" };
    }
  }

  // 2. 模糊匹配: 前缀 20 字同 或 编辑距离小 — 取距离最小者
  let best: TitleMatchResult | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const cand = normalizeTitle(c.title);
    if (!cand) continue;
    // 2a. 前缀 20 字符相同 (双方都够长才有意义)
    if (target.length >= FUZZY_PREFIX_LEN && cand.length >= FUZZY_PREFIX_LEN
      && target.slice(0, FUZZY_PREFIX_LEN) === cand.slice(0, FUZZY_PREFIX_LEN)) {
      if (bestDist > 0) { best = { contentId: c.contentId, matchType: "fuzzy", distance: -1 }; bestDist = 0; }
      continue;
    }
    // 2b. 编辑距离
    const threshold = fuzzyThreshold(target.length, cand.length);
    const d = levenshtein(target, cand, threshold);
    if (d <= threshold && d < bestDist) {
      best = { contentId: c.contentId, matchType: "fuzzy", distance: d };
      bestDist = d;
    }
  }
  return best;
}
