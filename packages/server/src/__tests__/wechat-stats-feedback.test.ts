/**
 * 7-06 效果数据回流 — 纯函数层单测。
 *   ① title-match: 标题精确/模糊/不匹配 (回流逐篇匹配 contents 的核心规则)
 *   ③ category-weights: 权重归一化 (log 缩放 + [0.5, 2.0] 防爆边界 + 最少样本数)
 * 两个模块顶层零 DB/env 依赖 (DB 走函数内动态 import), 可直接 import。
 */
import { describe, it, expect, vi } from "vitest";

// wechat-stats-collector 顶层 import db/env/logger — 测试只用其纯函数, mock 掉外设 (同 keyword-trend 模式)
vi.mock("../models/db.js", () => ({ db: {} }));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test", WECHAT_STATS_CRON_HOUR: 9,
  },
}));

const { normalizeTitle, levenshtein, fuzzyThreshold, matchArticleToContent } =
  await import("../services/metrics/title-match.js");
const { normalizeCategoryWeights, WEIGHT_MIN, WEIGHT_MAX, MIN_CATEGORY_SAMPLES } =
  await import("../services/recommendation/category-weights.js");
const { aggregateSummaryRows, bjYesterday } =
  await import("../services/metrics/wechat-stats-collector.js");

describe("normalizeTitle 标题归一化", () => {
  it("去掉半角/全角空格与零宽字符", () => {
    expect(normalizeTitle(" IF 8.5 毕业神刊　闭眼冲！ ")).toBe("IF8.5毕业神刊闭眼冲！");
    expect(normalizeTitle("A​B　C")).toBe("ABC");
  });
  it("null/undefined/空串 → 空串", () => {
    expect(normalizeTitle(null)).toBe("");
    expect(normalizeTitle(undefined)).toBe("");
    expect(normalizeTitle("   ")).toBe("");
  });
});

describe("levenshtein 编辑距离", () => {
  it("基础距离", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("毕业神刊", "毕业水刊")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("超过 maxDistance 提前退出返回 maxDistance+1", () => {
    expect(levenshtein("完全不一样的标题啊", "另一个主题的文章哦", 2)).toBe(3);
  });
});

describe("matchArticleToContent ① 精确/模糊/不匹配", () => {
  const candidates = [
    { contentId: "c1", title: "IF 8.5 审稿快 免版面费 毕业党闭眼冲！" },
    { contentId: "c2", title: "期刊解读:中科院数学2区《Applied Math》投稿指南" },
    { contentId: "c3", title: null },
  ];

  it("精确匹配: 去空格后全等 (运营原样群发)", () => {
    const r = matchArticleToContent("IF 8.5 审稿快 免版面费 毕业党闭眼冲！", candidates);
    expect(r).toEqual({ contentId: "c1", matchType: "exact" });
  });

  it("精确匹配: 运营只动了空格也算 exact", () => {
    const r = matchArticleToContent("IF 8.5 审稿快 免版面费 毕业党 闭眼冲！", candidates);
    expect(r?.contentId).toBe("c1");
    expect(r?.matchType).toBe("exact");
  });

  it("模糊匹配: 前缀 20 字符相同 (运营改了结尾)", () => {
    // normalize 后 c2 = "期刊解读:中科院数学2区《AppliedMath》投稿指南" — 前 20 字符一致, 结尾被运营改掉
    const r = matchArticleToContent("期刊解读:中科院数学2区《Applied Math》超全攻略", candidates);
    expect(r?.contentId).toBe("c2");
    expect(r?.matchType).toBe("fuzzy");
  });

  it("模糊匹配: 编辑距离小 (改了几个字)", () => {
    const r = matchArticleToContent("IF 8.5 审稿快 免版面费 硕博党闭眼冲！", candidates);
    expect(r?.contentId).toBe("c1");
    expect(r?.matchType).toBe("fuzzy");
  });

  it("不匹配: 完全无关标题 → null (落未匹配清单, 不硬塞)", () => {
    expect(matchArticleToContent("今天食堂的红烧肉真好吃", candidates)).toBeNull();
  });

  it("空标题/空候选 → null", () => {
    expect(matchArticleToContent("", candidates)).toBeNull();
    expect(matchArticleToContent("随便一个标题", [])).toBeNull();
  });

  it("fuzzyThreshold: 短标题最少容 2, 长标题按 10%", () => {
    expect(fuzzyThreshold(8, 8)).toBe(2);
    expect(fuzzyThreshold(40, 42)).toBe(4);
  });
});

describe("normalizeCategoryWeights ③ 权重归一化 (防爆)", () => {
  it("无数据 → 空 (调用方回退全 1)", () => {
    expect(normalizeCategoryWeights({})).toEqual({});
  });

  it("样本不足 MIN_CATEGORY_SAMPLES 的学科不产出权重 (保持 1)", () => {
    const w = normalizeCategoryWeights({
      medicine: { avg: 5000, samples: MIN_CATEGORY_SAMPLES - 1 },
    });
    expect(w.medicine).toBeUndefined();
  });

  it("均值持平的学科权重 ≈ 1", () => {
    const w = normalizeCategoryWeights({
      medicine: { avg: 1000, samples: 5 },
      education: { avg: 1000, samples: 5 },
    });
    expect(w.medicine).toBeCloseTo(1, 3);
    expect(w.education).toBeCloseTo(1, 3);
  });

  it("表现好 → >1, 表现差 → <1, 且 log 缩放减半 (4x 均值 → 2^(log2(ratio)/2))", () => {
    const w = normalizeCategoryWeights({
      hot: { avg: 3000, samples: 5 },
      cold: { avg: 1000, samples: 5 },
    });
    expect(w.hot).toBeGreaterThan(1);
    expect(w.cold).toBeLessThan(1);
    // global = 2000; hot ratio=1.5 → 2^(log2(1.5)/2)=sqrt(1.5)≈1.2247 (线性下是 1.5)
    expect(w.hot).toBeCloseTo(Math.sqrt(1.5), 3);
    expect(w.cold).toBeCloseTo(Math.sqrt(0.5), 3);
  });

  it("防爆上限: 爆款学科 (远超均值) 被 clamp 到 WEIGHT_MAX=2.0", () => {
    // 8 个普通学科 + 1 个 100x 爆款: global≈12000, ratio≈8.3 → log2≈3.06 → /2≈1.53 → clamp 1 → 2^1 = 2.0
    const perf: Record<string, { avg: number; samples: number }> = {
      viral: { avg: 100000, samples: 5 },
    };
    for (let i = 0; i < 8; i++) perf[`normal${i}`] = { avg: 1000, samples: 5 };
    const w = normalizeCategoryWeights(perf);
    expect(w.viral).toBe(WEIGHT_MAX);
    // 线性比例下 viral 会是 ~8.3 直接吃掉全部推荐位 — log 缩放 + clamp 把它按在 2.0
    expect(w.normal0).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });

  it("防爆下限: 极差学科被 clamp 到 WEIGHT_MIN=0.5 (不清零, 留翻身机会)", () => {
    const w = normalizeCategoryWeights({
      dead: { avg: 1, samples: 5 },
      hot1: { avg: 5000, samples: 5 },
      hot2: { avg: 5000, samples: 5 },
    });
    expect(w.dead).toBe(WEIGHT_MIN);
  });

  it("avg ≤ 0 的学科被过滤", () => {
    const w = normalizeCategoryWeights({
      zero: { avg: 0, samples: 10 },
      ok: { avg: 100, samples: 5 },
    });
    expect(w.zero).toBeUndefined();
    expect(w.ok).toBeCloseTo(1, 3); // 只剩它一个, global=自己 → 1
  });
});

describe("aggregateSummaryRows / bjYesterday 工具", () => {
  it("同标题多行 (多图文位置/重复行) 聚合求和", () => {
    const rows = aggregateSummaryRows([
      { title: "标题A", msgid: "1_1", int_page_read_count: 100, share_count: 5, add_to_fav_count: 2 },
      { title: "标题 A", msgid: "1_2", int_page_read_count: 30, share_count: 1, add_to_fav_count: 0 },
      { title: "标题B", msgid: "2_1", int_page_read_count: 50 },
    ]);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.title === "标题A")!;
    expect(a.reads).toBe(130);
    expect(a.shares).toBe(6);
    expect(a.favs).toBe(2);
    expect(a.msgids).toEqual(["1_1", "1_2"]);
  });

  it("空标题行被跳过", () => {
    expect(aggregateSummaryRows([{ title: "", int_page_read_count: 10 }])).toHaveLength(0);
  });

  it("bjYesterday: UTC 2026-07-05 18:00 (BJ 7-06 02:00) 的昨日 = 2026-07-05", () => {
    expect(bjYesterday(Date.UTC(2026, 6, 5, 18, 0, 0))).toBe("2026-07-05");
  });
});
