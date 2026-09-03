/**
 * 件 1: 重跑风暴控制 (9-04)。
 *
 * 【病历】8-31 欠费 → 370 篇挂 deferred → 9-02 充值 → 02:07「服务已恢复, 开始自动重跑积压」
 * → 积压全部涌入队列, **和当天 18 篇新内容叠加** → 9-01 ¥162 / 9-02 ¥166(正常日 ¥15-25,
 * 7-10 倍) → 又欠费 → 积压更大 → 下次充值烧得更快。
 *
 * ▎ 每充一次钱, 钱先被旧积压吃掉, 新内容顺延到次日; 次日又是积压优先。
 * ▎ 这是个每天都在发生的死循环, 不是一次性事故。
 *
 * 而日上限闸从没拦住 —— 它按旧单价算, 真实撞线要 ¥195(已由 #250 修正为真价)。
 *
 * 这组用例锁四条判据(a/b/c/d), e 的归因能力由停止条件那条 SQL 验。
 */
import { describe, it, expect } from "vitest";
import {
  isDeferredExpired, canAutoRetry, DEFERRED_EXPIRE_HOURS, DEFERRED_MAX_RETRY,
  type DeferredMark,
} from "../services/ops/deferred.js";
import { maxArticleRetryPerRun, MAX_ARTICLE_RETRY_PER_RUN_DIVISOR } from "../services/ops/service-health-probe.js";

const NOW = new Date("2026-09-04T00:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const mk = (over: Partial<DeferredMark> = {}): DeferredMark => ({
  reason: "service_down", detail: "外部服务当时不可用", failedAt: hoursAgo(1),
  retryCount: 0, input: { kind: "article_generation" } as DeferredMark["input"], ...over,
});

describe("b. 超 72 小时作废", () => {
  it("71 小时 → 没过期; 73 小时 → 过期", () => {
    expect(isDeferredExpired(mk({ failedAt: hoursAgo(71) }), NOW)).toBe(false);
    expect(isDeferredExpired(mk({ failedAt: hoursAgo(73) }), NOW)).toBe(true);
  });

  it("阈值就是 72 小时(锁住常数, 改了要有人知道)", () => {
    expect(DEFERRED_EXPIRE_HOURS).toBe(72);
  });

  it("🔴 failedAt 缺失或不可解析 → 按**未过期**处理, 宁可多跑一次也不误废", () => {
    expect(isDeferredExpired(mk({ failedAt: "" }), NOW)).toBe(false);
    expect(isDeferredExpired(mk({ failedAt: "不是日期" }), NOW)).toBe(false);
  });

  it("过期的不再自动重跑 —— 即使它还没被标记 expired", () => {
    expect(canAutoRetry(mk({ failedAt: hoursAgo(100) }), NOW)).toBe(false);
  });

  it("已标 expired 的不再重跑", () => {
    expect(canAutoRetry(mk({ expired: true }), NOW)).toBe(false);
  });

  it("没过期的照常重跑(别把正常路径一起关了)", () => {
    expect(canAutoRetry(mk({ failedAt: hoursAgo(2) }), NOW)).toBe(true);
  });

  it("原有的三条门槛不受影响", () => {
    expect(canAutoRetry(mk({ exhausted: true }), NOW)).toBe(false);
    expect(canAutoRetry(mk({ requeuedAt: hoursAgo(1) }), NOW)).toBe(false);
    expect(canAutoRetry(mk({ retryCount: DEFERRED_MAX_RETRY }), NOW)).toBe(false);
  });
});

describe("b-2. 🔴 作废必须按批聚合成一条 incident, 不是一条一个", () => {
  /**
   * 首次上线时 8-31 那批积压会一口气作废 ~370 条。
   * 落 370 条 incident 就是《沉默检查器盘点》说的反面 —— 一个"喊的"检查器:
   * 简报里 370 行会把当天所有别的告警全冲没, 而运营需要知道的只有
   * "作废了多少、最老的多久了"。
   */
  function buildExpiredIncident(rows: Array<{ id: string; mark: DeferredMark }>) {
    if (rows.length === 0) return null;
    const failedAts = rows.map((r) => r.mark.failedAt).filter(Boolean).sort();
    const byKind: Record<string, number> = {};
    for (const r of rows) {
      const k = (r.mark.input as { kind?: string } | undefined)?.kind ?? "unknown";
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    return {
      kind: "deferred_expired",
      detail: {
        count: rows.length,
        oldestFailedAt: failedAts[0] ?? null,
        newestFailedAt: failedAts[failedAts.length - 1] ?? null,
        byKind,
        sampleContentIds: rows.slice(0, 20).map((r) => r.id),
      },
    };
  }

  const many = Array.from({ length: 370 }, (_, i) => ({
    id: `id-${i}`,
    mark: mk({ failedAt: hoursAgo(80 + (i % 40)) }),
  }));

  it("370 条作废 → 只产生 1 条 incident", () => {
    const incidents = [buildExpiredIncident(many)].filter(Boolean);
    expect(incidents).toHaveLength(1);
  });

  it("detail 带 count 和最老/最新 failedAt", () => {
    const inc = buildExpiredIncident(many)!;
    expect(inc.detail.count).toBe(370);
    expect(inc.detail.oldestFailedAt).toBeTruthy();
    expect(inc.detail.newestFailedAt).toBeTruthy();
    expect(inc.detail.oldestFailedAt! <= inc.detail.newestFailedAt!).toBe(true);
  });

  it("detail 里只留少量样本 id —— 370 个塞进 jsonb 没人看", () => {
    expect(buildExpiredIncident(many)!.detail.sampleContentIds).toHaveLength(20);
  });

  it("按 input.kind 分类计数(运营要知道作废的是文章还是视频)", () => {
    const mixed = [
      { id: "a", mark: mk({ failedAt: hoursAgo(100) }) },
      { id: "b", mark: mk({ failedAt: hoursAgo(100), input: { kind: "dvh_text" } as DeferredMark["input"] }) },
    ];
    expect(buildExpiredIncident(mixed)!.detail.byKind).toEqual({ article_generation: 1, dvh_text: 1 });
  });

  it("没有过期条目时不产生 incident(别每轮报一条「作废了 0 条」)", () => {
    expect(buildExpiredIncident([])).toBeNull();
  });
});

describe("c. 恢复后限速 N/8", () => {
  it("日配额 40 → 每轮最多 5 篇", () => {
    expect(maxArticleRetryPerRun(40)).toBe(5);
    expect(MAX_ARTICLE_RETRY_PER_RUN_DIVISOR).toBe(8);
  });

  it("🔴 配额再小也至少派 1 篇 —— 否则积压永远不动, 变成静默堆积", () => {
    expect(maxArticleRetryPerRun(1)).toBe(1);
    expect(maxArticleRetryPerRun(0)).toBe(1);
  });

  it("限速是每轮不是每天: 探测每 30 分钟一轮, 天花板由日预算闸兜", () => {
    // 这条只锁"除法关系"本身, 防止有人把它改成"每天最多 N/8"
    expect(maxArticleRetryPerRun(80)).toBe(10);
  });
});

describe("a. 重跑占配额的扣减算法", () => {
  /** 与 daily-cron 里的扣减逻辑同构 —— 那段是内联的, 这里锁行为 */
  function deduct(cq: Record<string, { count: number }>, retried: number) {
    let left = retried;
    const out = { ...cq };
    for (const k of Object.keys(out).sort((a, b) => out[b].count - out[a].count)) {
      if (left <= 0) break;
      const cut = Math.min(out[k].count, left);
      out[k] = { count: out[k].count - cut };
      left -= cut;
    }
    return { out, left };
  }

  it("重跑 5 篇 → 当天新排减 5(总量不叠加)", () => {
    const { out } = deduct({ domestic: { count: 10 }, international: { count: 8 } }, 5);
    expect(out.domestic.count + out.international.count).toBe(13);
  });

  it("🔴 从大的那类先扣 —— 不许把小类型直接扣成 0 而大类型纹丝不动", () => {
    const { out } = deduct({ domestic: { count: 10 }, international: { count: 2 } }, 3);
    expect(out.domestic.count).toBe(7);
    expect(out.international.count).toBe(2);
  });

  it("扣到 0 是允许的结果(那天产能全用来补积压), 不是故障", () => {
    const { out, left } = deduct({ domestic: { count: 3 } }, 10);
    expect(out.domestic.count).toBe(0);
    expect(left).toBe(7);   // 吸收不下的部分要能看见, 用于日志
  });

  it("没有重跑时配额原样不动", () => {
    const { out } = deduct({ domestic: { count: 10 } }, 0);
    expect(out.domestic.count).toBe(10);
  });
});

describe("d. 顺延必须保留 isRetry / deferredRetryCount", () => {
  /**
   * batch-worker 撞顶顺延时重新入队。原来只带
   * { batchId, rowId, tenantId, userId, deferCount } —— 一条重跑行顺延一次就退化成普通行,
   * deferredRetryCount 归 0, 而 dispatchRetry 的注释明写着
   * 「重跑失败时把计数带回去, 否则每次都从 0 开始 = 上限形同虚设」。
   *
   * 同时 isRetry 丢了会让件 1(e) 的归因失真: 顺延过的重跑行被记成新内容。
   */
  function buildDeferJob(job: { data: Record<string, unknown> }, deferCount: number) {
    const { batchId, rowId, tenantId, userId } = job.data;
    return {
      batchId, rowId, tenantId, userId, deferCount: deferCount + 1,
      isRetry: job.data.isRetry,
      deferredRetryCount: job.data.deferredRetryCount,
      autoRetryCount: job.data.autoRetryCount,
    };
  }

  it("顺延一次再读回, 两个字段都还在", () => {
    const job = { data: { batchId: "b", rowId: "r", tenantId: "t", userId: "u", isRetry: true, deferredRetryCount: 3 } };
    const next = buildDeferJob(job, 0);
    expect(next.isRetry).toBe(true);
    expect(next.deferredRetryCount).toBe(3);
  });

  it("连续顺延两次仍然保留(计数不会被逐轮抹掉)", () => {
    const first: { data: Record<string, unknown> } = {
      data: { batchId: "b", rowId: "r", tenantId: "t", userId: "u", isRetry: true, deferredRetryCount: 3 },
    };
    const second: { data: Record<string, unknown> } = { data: { ...buildDeferJob(first, 0) } };
    const twice = buildDeferJob(second, 1);
    expect(twice.isRetry).toBe(true);
    expect(twice.deferredRetryCount).toBe(3);
    expect(twice.deferCount).toBe(2);
  });

  it("普通行(非重跑)顺延后 isRetry 仍是 undefined, 不会被误标成重跑", () => {
    const job = { data: { batchId: "b", rowId: "r", tenantId: "t", userId: "u" } };
    expect(buildDeferJob(job, 0).isRetry).toBeUndefined();
  });
});
