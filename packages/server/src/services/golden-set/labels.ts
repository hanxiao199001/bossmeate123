/**
 * Golden Set 标签值域 —— 唯一真相源。
 *
 * 三档而不是五档/十分制: 老板 4-5 小时要标 40-50 篇, 每篇平均 5 分钟里真正花在
 * "判断"上的时间只有几十秒。档位越细, 标注者内部一致性(同一人隔天标同一篇)越差,
 * 而 Golden Set 的全部价值就建立在"这把尺子稳"上面。三档 = 能发 / 改改能发 / 别发,
 * 恰好对应下游三种动作, 也是日后算相关性时最不容易被噪音吃掉的粒度。
 */
export const GOLDEN_LABELS = ["good", "fair", "poor"] as const;
export type GoldenLabel = (typeof GOLDEN_LABELS)[number];

export function isGoldenLabel(v: unknown): v is GoldenLabel {
  return typeof v === "string" && (GOLDEN_LABELS as readonly string[]).includes(v);
}

/** 前端文案(后端也用于导出报表, 避免两边各写一套) */
export const GOLDEN_LABEL_TEXT: Record<GoldenLabel, string> = {
  good: "好 — 可以直接发",
  fair: "中 — 改改能发",
  poor: "差 — 不能发",
};

/** 算相关性时把三档映射成序数(Spearman / 点二列相关都要数值) */
export const GOLDEN_LABEL_ORDINAL: Record<GoldenLabel, number> = {
  good: 3,
  fair: 2,
  poor: 1,
};
