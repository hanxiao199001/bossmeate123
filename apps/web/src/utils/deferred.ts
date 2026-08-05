/**
 * 8-03 "待重试" 显示口径(前端唯一真相源)。
 *
 * 【要解决什么】8-03 百炼欠费, 一批内容变成 status=failed / needs_review。
 *   运营在列表里看到的是"失败", 于是要么去找人、要么就当这批内容废了 ——
 *   而真相是: 这些内容一点问题没有, 是 AI 服务当时不可用, 充值后系统会自己重跑。
 *   "失败"和"待重试"在运营那里是**两种完全不同的动作**(找人 vs 什么都不用做),
 *   显示成同一个词就等于逼着人去做本来不用做的事。
 *
 * 判据是后端写在 metadata.deferred 里的那个块(services/ops/deferred.ts), 前端只做显示。
 * 刻意不新增状态值 —— status 仍是 failed/needs_review, 词表/状态机一律不动。
 */

export interface DeferredInfo {
  /** quota_exceeded = 欠费/额度用尽; service_down = 外部服务当时不可用 */
  reason: string;
  detail?: string;
  retryCount?: number;
  /** 自动重试次数用尽 → 这条真的要人处理了 */
  exhausted?: boolean;
}

/** 从 metadata(内容列表)或接口直给的 deferred 字段里读出标记; 形状不对一律当没有 */
export function readDeferred(source: unknown): DeferredInfo | null {
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;
  const d = ("deferred" in obj ? obj.deferred : obj) as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return null;
  const reason = d.reason;
  if (reason !== "quota_exceeded" && reason !== "service_down") return null;
  return {
    reason,
    ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
    ...(Number.isFinite(Number(d.retryCount)) ? { retryCount: Number(d.retryCount) } : {}),
    ...(d.exhausted === true ? { exhausted: true } : {}),
  };
}

const REASON_TEXT: Record<string, string> = {
  quota_exceeded: "AI 账户欠费/额度用尽",
  service_down: "外部服务当时不可用",
};

/** 徽章文案 + 悬停提示 + 配色。exhausted 的那条要变红 —— 它是真要人管的。 */
export function deferredBadge(d: DeferredInfo): { label: string; title: string; cls: string } {
  const why = d.detail || REASON_TEXT[d.reason] || "外部服务当时不可用";
  if (d.exhausted) {
    return {
      label: "重试已停",
      title: `${why}｜已自动重试 ${d.retryCount ?? 0} 次仍失败, 需人工处理`,
      cls: "bg-red-100 text-red-700",
    };
  }
  const tried = d.retryCount ? `已自动重试 ${d.retryCount} 次｜` : "";
  return {
    label: "待重试",
    title: `${why}｜${tried}原稿已保存, 服务恢复后系统会自动重跑, 不用管`,
    cls: "bg-amber-100 text-amber-700",
  };
}
