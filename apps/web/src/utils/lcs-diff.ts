/**
 * 行级 LCS diff（task #20，T4-2-2 frontend）。
 *
 * 自写 30 行 LCS DP，不引入 npm diff / diff-match-patch 依赖。
 * 用于 RewriteSectionModal 展示 originalBody → rewrittenBody 红绿色块。
 *
 * 性能：典型章节 ~50-200 行，O(m·n) DP 走得过；超过 5k 行的极端情况降级展示。
 */

export type DiffSegment = { type: "same" | "added" | "removed"; text: string };

/** 比较两段多行文本，返回行级 diff 段落数组。 */
export function diffLines(original: string, rewritten: string): DiffSegment[] {
  const a = original.split("\n");
  const b = rewritten.split("\n");
  const m = a.length;
  const n = b.length;
  // LCS 长度表
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯重建 segments
  const segments: DiffSegment[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      segments.unshift({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segments.unshift({ type: "added", text: b[j - 1] });
      j--;
    } else {
      segments.unshift({ type: "removed", text: a[i - 1] });
      i--;
    }
  }
  return segments;
}
