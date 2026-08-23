/**
 * 截断误伤内容重评 —— 红线 #21 的**一次性例外**（老韩 2026-08-23 批准）。
 *
 * ═══ 凭什么允许跑 ═══
 *
 * 红线 #21 白纸黑字禁止「批量重跑质检」。本次是显式例外，不是绕过 ——
 * 批准原文落进每一行审计的 `exception_ref`。
 *
 * ▎ 绕过和被批准的例外，一周后回看是两件事。
 *
 * ═══ 口径更正（8-23，跑之前发现）═══
 *
 * 批准文本写「289 篇 = 183 截断组 + 50 对照组 + 56 零6维组」，但 **56 ⊂ 183**：
 *
 * ```
 * 零1-5维   127     ← 真正的截断组
 * 零6维      56     ← 单列（分布在 6 处有尖峰，可能是第二种机制）
 * 任一维=0  183     = 127 + 56
 * 全非零    969     ← 对照池，抽 50
 * ```
 *
 * 实际不重复范围 = **233 篇**，预算约 ¥6.8。比批的少，且是同一意图去重后的结果，
 * 故在批准范围内。两个数都记进 exception_ref。
 *
 * ═══ 为什么必须有对照组 ═══
 *
 * 这批的原分是 legacy 尺打的，重评用 v5 尺 —— 中间隔着件1/件2/截断修复三件。
 * 「总分会上升」不用测就知道，那正是那几件改动的目的。
 *
 * 🔴 **对照组 = 同期、同 legacy 尺、六维全非零**，用 v5 重评一次，
 * 拿到的 Δ 中位数就是**纯标尺偏移量**。截断组的 Δ 减掉它，才是截断真正吃掉的分。
 * 不减就是拿放宽后的尺子救老内容 —— 那是给自己发奖金。
 *
 * ═══ 恢复判据：三条全中才恢复（老韩定，跑之前写死）═══
 *
 * ```
 * ① 六维全非零              确认原来那次确实是崩溃，不是内容真差
 * ② 新分 − 标尺偏移量 ≥ 80，且每维 ≥ 6
 * ③ 升幅穿透噪音带上界      79→81 什么都不证明（同尺 5 轮标定：总分噪音 3~4）
 * ```
 *
 * 恢复到 `generated`（**不是** needs_review：那里积压 186 篇零消化，恢复过去等于埋葬；
 * 也不是直接分发：`generated` 会走正常分发流程，`<60` 闸还在把关，有第二道）。
 *
 * 不满足的：保持 archived，但把重评结果写进 metadata ——
 * 下次有人问「这批查过没有」，有答案。
 *
 * ═══ 用法 ═══
 *
 * ```bash
 * set -a && . .env && set +a
 * npx tsx src/scripts/rescore-truncated.ts              # dry-run（默认，只报不写）
 * npx tsx src/scripts/rescore-truncated.ts --apply      # 落库
 * ```
 *
 * 形态照抄 `rescore-cn-core.ts`（红线 #11）：默认 dry-run / --apply 才写 / 幂等。
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents, contentRescoreAudits } from "../models/schema.js";
import { sixDimQualityCheck } from "../services/content-engine/quality-check-v2.js";
import { SIX_DIM_SCORING_VERSION, SIX_DIM_PUBLISH_TOTAL } from "../services/content-engine/quality-thresholds.js";
import { logger } from "../config/logger.js";

const APPLY = process.argv.includes("--apply");

/**
 * 🔴 评分结果落盘 —— **dry-run 与 --apply 不许各评一遍**。
 *
 * 8-23 差点踩到: "dry-run 只跳过落库、不跳过 LLM 调用", 所以
 * `dry-run(¥6.8) + --apply(¥6.8) = ¥13.6` 会直接撞破 ¥12.75 的硬停线 ——
 * 而红线 #21 的例外只批了一次的钱。
 *
 * 解耦形态照抄 task#104 阶段2 的万方回填(红线 #11):
 * **先跑分落盘 → 看过之后 --apply 只读盘不再调 LLM**。
 * 崩了也能 resume, 已评过的不会重复烧钱。
 */
const CACHE = process.env.RESCORE_CACHE ?? "/tmp/rescore-2026-08-23.jsonl";

/** 批准原文 —— 每一行审计都带它。「凭什么允许改」必须有归宿。 */
const EXCEPTION_REF = {
  redline: "#21 不批量重跑质检",
  kind: "一次性例外",
  approvedBy: "韩(han)",
  approvedAt: "2026-08-23",
  scopeApproved: "289 篇(183 截断组 + 50 对照组 + 56 零6维组)",
  scopeActual: "233 篇(127 截断 + 56 零6维 + 50 对照) —— 56 ⊂ 183, 原文双重计数, 去重后在批准范围内",
  budgetYuan: 8.5,
  reason: "评分器截断 bug 误伤, 非内容质量问题",
  constraints: ["结果不论好坏如实报", "恢复须扣除标尺偏移量", "全程落审计行"],
} as const;

/** 每次质检调用均价（分）。实测 4289 次 ¥125.59 → 2.93 分/次。 */
const CENTS_PER_CALL = 2.93;
const BUDGET_CENTS = 850;
/** 超支 50% 自动停 —— 批准文本里的硬约束 */
const HARD_STOP_CENTS = Math.round(BUDGET_CENTS * 1.5);

/**
 * 总分噪音带上界。同尺 5 轮标定实测：两跑总分差 3~4、单维 ±1.3。
 * 判据 ③ 用它 —— 升幅落在噪音里的不算「被冤枉」的证据。
 */
const NOISE_BAND_UPPER = 4;
const DIM_FLOOR = 6;
const CONCURRENCY = 5;

type Batch = "truncated" | "zero6" | "control";
interface Sample { id: string; tenantId: string; status: string; title: string; body: string; oldTotal: number | null; oldVersion: string | null; zeroN: number; batch: Batch }
interface Scored extends Sample { newTotal: number | null; newDims: Record<string, number> | null; degraded: boolean; err?: string }

async function pickSamples(): Promise<Sample[]> {
  const rows = (await db.execute(sql`
    SELECT c.id, c.tenant_id, c.status, c.title, c.body,
           NULLIF(c.metadata->>'sixDimTotal','')::numeric AS old_total,
           c.metadata->>'sixDimScoringVersion' AS old_version,
           (SELECT count(*) FROM jsonb_each(c.metadata->'sixDimScores') e WHERE (e.value)::text='0')::int AS zero_n
    FROM contents c
    WHERE jsonb_typeof(c.metadata->'sixDimScores') = 'object'
      AND coalesce(c.metadata->>'sixDimScoringVersion','legacy') <> ${SIX_DIM_SCORING_VERSION}
  `) as unknown as { rows: Array<Record<string, unknown>> }).rows;

  const all = rows.map((r) => ({
    id: String(r.id), tenantId: String(r.tenant_id), status: String(r.status),
    title: String(r.title ?? ""), body: String(r.body ?? ""),
    oldTotal: r.old_total == null ? null : Number(r.old_total),
    oldVersion: r.old_version == null ? null : String(r.old_version),
    zeroN: Number(r.zero_n ?? 0),
  }));

  const truncated = all.filter((r) => r.zeroN >= 1 && r.zeroN <= 5).map((r) => ({ ...r, batch: "truncated" as const }));
  const zero6 = all.filter((r) => r.zeroN === 6).map((r) => ({ ...r, batch: "zero6" as const }));
  // 对照组：全非零，取最近 50 篇（同期，与截断组时间窗可比）
  const control = all.filter((r) => r.zeroN === 0).slice(0, 50).map((r) => ({ ...r, batch: "control" as const }));
  return [...truncated, ...zero6, ...control];
}

async function scoreAll(samples: Sample[]): Promise<{ scored: Scored[]; spentCents: number; stopped: boolean }> {
  const { existsSync, readFileSync, appendFileSync } = await import("node:fs");
  // 已评过的直接复用, 一次都不重复烧钱
  const cached = new Map<string, Scored>();
  if (existsSync(CACHE)) {
    for (const line of readFileSync(CACHE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line) as Scored; cached.set(o.id, o); } catch { /* 坏行跳过 */ }
    }
    console.log(`  复用已评结果 ${cached.size} 篇(${CACHE}) —— 这部分不再调 LLM`);
  }
  const scored: Scored[] = [];
  let spentCents = 0;
  let stopped = false;
  for (let i = 0; i < samples.length; i += CONCURRENCY) {
    if (spentCents >= HARD_STOP_CENTS) {
      stopped = true;
      logger.error({ spentCents, hardStop: HARD_STOP_CENTS, done: scored.length, total: samples.length },
        "🔴 超支 50% —— 自动停并报告(批准文本里的硬约束)");
      break;
    }
    const chunk = samples.slice(i, i + CONCURRENCY);
    const fresh = chunk.filter((s) => !cached.has(s.id));
    scored.push(...chunk.filter((s) => cached.has(s.id)).map((s) => cached.get(s.id)!));
    const out = await Promise.all(fresh.map(async (s): Promise<Scored> => {
      try {
        /**
         * 🔴 用**这篇内容自己的 tenantId**。
         * 第一版硬编码了零 uuid —— 那个租户在 tenants 表里不存在, 于是每次调用的
         * cost_ledger 插入都撞外键 (`cost_ledger_tenant_id_fkey`), 钱花了记不上账。
         * FK 约束替我大声失败了, 否则这批的成本会全部消失。
         */
        const r = await sixDimQualityCheck({ tenantId: s.tenantId, title: s.title, body: s.body });
        return {
          ...s, degraded: r.degraded, newTotal: r.totalScore,
          newDims: r.degraded ? null : Object.fromEntries(Object.entries(r.dims).map(([k, v]) => [k, v.score])),
        };
      } catch (err) {
        return { ...s, degraded: true, newTotal: null, newDims: null, err: err instanceof Error ? err.message : String(err) };
      }
    }));
    for (const o of out) appendFileSync(CACHE, JSON.stringify(o) + "\n");   // 逐篇落盘, 崩了可 resume
    scored.push(...out);
    spentCents += fresh.length * CENTS_PER_CALL;
    process.stdout.write(`\r  已评 ${scored.length}/${samples.length}  花费 ≈¥${(spentCents / 100).toFixed(2)}`);
  }
  process.stdout.write("\n");
  return { scored, spentCents, stopped };
}

/** 中位数。对照组的 Δ 中位数 = 纯标尺偏移量。 */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

async function main(): Promise<void> {
  console.log(`\n═══ 截断误伤重评 ${APPLY ? "【落库】" : "【dry-run，只报不写】"} ═══`);
  console.log(`批准: ${EXCEPTION_REF.approvedBy} ${EXCEPTION_REF.approvedAt} —— ${EXCEPTION_REF.redline} 的${EXCEPTION_REF.kind}\n`);

  const samples = await pickSamples();
  const counts = { truncated: 0, zero6: 0, control: 0 } as Record<Batch, number>;
  samples.forEach((s) => { counts[s.batch]++; });
  console.log(`样本: 截断 ${counts.truncated} / 零6维 ${counts.zero6} / 对照 ${counts.control} = ${samples.length} 篇`);
  console.log(`预算: ¥${(BUDGET_CENTS / 100).toFixed(2)}，硬停 ¥${(HARD_STOP_CENTS / 100).toFixed(2)}；预估 ¥${(samples.length * CENTS_PER_CALL / 100).toFixed(2)}\n`);

  const { scored, spentCents, stopped } = await scoreAll(samples);

  // ── 标尺偏移量：只用对照组算 ────────────────────────────────
  const controlDeltas = scored
    .filter((s) => s.batch === "control" && !s.degraded && s.newTotal != null && s.oldTotal != null)
    .map((s) => s.newTotal! - s.oldTotal!);
  const rulerOffset = median(controlDeltas);
  console.log(`\n标尺偏移量(对照组 Δ 中位数, n=${controlDeltas.length}): ${rulerOffset == null ? "算不出" : rulerOffset.toFixed(2)}`);
  if (rulerOffset == null) {
    console.log("🔴 对照组没算出偏移量 → **不做任何恢复**(不扣偏移量的恢复 = 给自己发奖金)。");
  }

  // ── 逐篇判恢复 ───────────────────────────────────────────────
  let restored = 0, kept = 0, failed = 0;
  for (const s of scored) {
    if (s.batch === "control") continue;   // 对照组只提供偏移量，不参与恢复

    const reasons: Array<{ criterion: string; pass: boolean; detail: string }> = [];
    let decision: "restored" | "kept_archived" | "rescore_failed" = "kept_archived";

    if (s.degraded || s.newTotal == null || s.newDims == null) {
      decision = "rescore_failed";
      reasons.push({ criterion: "重评本身", pass: false, detail: s.err ?? "degraded(没评上分 ≠ 评了 0 分)" });
      failed++;
    } else {
      const c1 = Object.values(s.newDims).every((v) => v > 0);
      reasons.push({ criterion: "① 六维全非零", pass: c1, detail: JSON.stringify(s.newDims) });

      const adjusted = rulerOffset == null ? null : s.newTotal - rulerOffset;
      const floorOk = Object.values(s.newDims).every((v) => v >= DIM_FLOOR);
      const c2 = adjusted != null && adjusted >= SIX_DIM_PUBLISH_TOTAL && floorOk;
      reasons.push({ criterion: "② 扣偏移后 ≥80 且每维 ≥6", pass: c2,
        detail: `新分 ${s.newTotal} − 偏移 ${rulerOffset ?? "n/a"} = ${adjusted?.toFixed(2) ?? "n/a"}；地板 ${floorOk ? "过" : "未过"}` });

      const gain = s.oldTotal == null ? null : s.newTotal - s.oldTotal;
      const c3 = gain != null && gain > NOISE_BAND_UPPER;
      reasons.push({ criterion: "③ 升幅穿透噪音带", pass: c3,
        detail: `升幅 ${gain?.toFixed(2) ?? "n/a"} vs 噪音带上界 ${NOISE_BAND_UPPER}` });

      if (c1 && c2 && c3) { decision = "restored"; restored++; } else { kept++; }
    }

    if (APPLY) {
      await db.insert(contentRescoreAudits).values({
        contentId: s.id, batch: s.batch,
        oldStatus: s.status,
        newStatus: decision === "restored" ? "generated" : s.status,
        oldTotal: s.oldTotal?.toString() ?? null,
        newTotal: s.newTotal?.toString() ?? null,
        oldVersion: s.oldVersion ?? "legacy",
        newVersion: decision === "rescore_failed" ? null : SIX_DIM_SCORING_VERSION,
        rulerOffset: rulerOffset?.toString() ?? null,
        decision, reasons,
        costCents: Math.round(CENTS_PER_CALL),
        exceptionRef: EXCEPTION_REF, approvedBy: EXCEPTION_REF.approvedBy,
      });
      // 不满足的也把重评结果写进 metadata —— 下次有人问「这批查过没有」，有答案
      await db.update(contents).set({
        ...(decision === "restored" ? { status: "generated" } : {}),
        metadata: sql`${contents.metadata} || ${JSON.stringify({
          rescore2026_08_23: {
            decision, newTotal: s.newTotal, newDims: s.newDims,
            rulerOffset, scoringVersion: SIX_DIM_SCORING_VERSION, batch: s.batch,
          },
        })}::jsonb`,
      }).where(eq(contents.id, s.id));
    }
  }

  // ── 如实报，不论好坏 ────────────────────────────────────────
  console.log(`\n═══ 结果 ═══`);
  console.log(`恢复 → generated : ${restored}`);
  console.log(`保持 archived    : ${kept}`);
  console.log(`重评也失败       : ${failed}   ← 第四组，既无新分也不进对照`);
  console.log(`实际花费         : ≈¥${(spentCents / 100).toFixed(2)}${stopped ? "  🔴 触发超支硬停" : ""}`);
  for (const b of ["truncated", "zero6"] as const) {
    const g = scored.filter((s) => s.batch === b && !s.degraded && s.newTotal != null && s.oldTotal != null);
    const dm = median(g.map((s) => s.newTotal! - s.oldTotal!));
    console.log(`  ${b} 组 Δ 中位数 ${dm?.toFixed(2) ?? "n/a"}（扣偏移后 ${dm != null && rulerOffset != null ? (dm - rulerOffset).toFixed(2) : "n/a"}）n=${g.length}`);
  }
  if (!APPLY) console.log(`\n⚠️ dry-run：一行都没写。确认无误后加 --apply。`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("挂了:", e); process.exit(1); });
