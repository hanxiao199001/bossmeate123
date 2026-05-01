/**
 * jsonb diff 可视预览（PR-1 admin v2 framework）。
 *
 * 用 diffJsonb 的 path-flatten 输出，逐行红/绿/黄高亮：
 *   - added：绿底 + path + after
 *   - removed：红底删除线 + path + before
 *   - changed：黄底 + path + before → after
 *
 * 拒绝整 JSON 拼字符串再 lcs-diff —— key 顺序 / 空白 / 引号 全是噪声。
 */
import { useMemo } from "react";
import { diffJsonb, type JsonbDiffEntry } from "../../utils/diff-jsonb";

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function JsonbDiffPreview({ before, after }: { before: unknown; after: unknown }) {
  const entries = useMemo<JsonbDiffEntry[]>(() => diffJsonb(before, after), [before, after]);

  if (entries.length === 0) {
    return <div className="text-xs text-gray-400 px-2 py-1">无变更</div>;
  }

  return (
    <div className="border border-gray-200 rounded bg-white text-xs font-mono divide-y divide-gray-100">
      {entries.map((e, i) => {
        const path = e.path || "(root)";
        if (e.type === "added") {
          return (
            <div key={i} className="px-2 py-1 bg-green-50 text-green-800">
              <span className="text-green-600 mr-2">+</span>
              <span className="text-gray-500">{path}</span>
              <span className="ml-2">{fmt(e.after)}</span>
            </div>
          );
        }
        if (e.type === "removed") {
          return (
            <div key={i} className="px-2 py-1 bg-red-50 text-red-800">
              <span className="text-red-600 mr-2">−</span>
              <span className="text-gray-500">{path}</span>
              <span className="ml-2 line-through">{fmt(e.before)}</span>
            </div>
          );
        }
        return (
          <div key={i} className="px-2 py-1 bg-yellow-50 text-yellow-900">
            <span className="text-yellow-700 mr-2">~</span>
            <span className="text-gray-500">{path}</span>
            <span className="ml-2 line-through text-red-700">{fmt(e.before)}</span>
            <span className="mx-1 text-gray-400">→</span>
            <span className="text-green-700">{fmt(e.after)}</span>
          </div>
        );
      })}
    </div>
  );
}
