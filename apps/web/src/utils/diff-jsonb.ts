/**
 * jsonb diff（PR-1 admin v2 framework）。
 *
 * 路径扁平化递归比较：把嵌套对象/数组拆成 path → leaf value，
 * 然后逐 path 对比 before/after 得到 added / removed / changed / same 四类。
 *
 * 为什么不用 lcs-diff（Day 1）：行级文本 diff 对 jsonb 噪声大（key 顺序、空白、引号），
 * UI 想呈现"editorInChief 改了 / data[2].if 改了"这种语义级 diff，必须用路径树。
 *
 * 边界：
 *   - undefined / null / missing key 视作 absent（避免 "null vs missing" 假差异）
 *   - 数组按下标对位（不是 LCS），因为表格 Editor 操作语义就是逐行替换
 *   - 标量直接 === 比较；NaN 视作相等（实际场景里都是 number/string，不会出现）
 */
export type JsonbDiffEntry = {
  path: string; // "data[0].year" 风格
  type: "added" | "removed" | "changed" | "same";
  before?: unknown;
  after?: unknown;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isAbsent(v: unknown): boolean {
  return v === undefined || v === null;
}

function joinPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "" ? key : `${parent}.${key}`;
}

/**
 * 扁平化递归 diff。include same 默认 false（UI 只关心变化）。
 */
export function diffJsonb(
  before: unknown,
  after: unknown,
  options: { includeSame?: boolean } = {},
): JsonbDiffEntry[] {
  const out: JsonbDiffEntry[] = [];
  walk("", before, after, out, !!options.includeSame);
  return out;
}

function walk(path: string, b: unknown, a: unknown, out: JsonbDiffEntry[], keepSame: boolean): void {
  const bAbsent = isAbsent(b);
  const aAbsent = isAbsent(a);
  if (bAbsent && aAbsent) return;
  if (bAbsent) { out.push({ path, type: "added", after: a }); return; }
  if (aAbsent) { out.push({ path, type: "removed", before: b }); return; }

  if (isPlainObject(b) && isPlainObject(a)) {
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    [...keys].sort().forEach((k) => walk(joinPath(path, k), b[k], a[k], out, keepSame));
    return;
  }
  if (Array.isArray(b) && Array.isArray(a)) {
    const len = Math.max(b.length, a.length);
    for (let i = 0; i < len; i++) walk(joinPath(path, i), b[i], a[i], out, keepSame);
    return;
  }
  // 类型不一致或标量
  if (b === a) {
    if (keepSame) out.push({ path, type: "same", before: b, after: a });
  } else {
    out.push({ path, type: "changed", before: b, after: a });
  }
}
