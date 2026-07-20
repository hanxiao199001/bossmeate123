/**
 * 7-05 ④ AI 审稿员 — 自动复审"六维低分灰区"(60-79 分)待审文章, 影子模式先行。
 *
 * 定位: 老韩每天面对一堆 needs_review, 其中红线类(标题矛盾/编造/降级)必须人工,
 * 但"六维低分"灰区大多是可判的。AI 审稿员按老韩的历史裁决标准(calibration 人工真值池 few-shot)
 * 复审这批, shadow 模式只记建议(待审卡片上显示"🤖 AI建议"), live 模式达信心阈值才自动动状态。
 *
 * 铁律:
 *   1. 红线类待审永远不碰 (ai-reviewer-rules.REDLINE_REVIEW_REASONS)。
 *   2. 裁决只写 metadata.aiReview, **绝不写 metadata.calibration** —
 *      calibration 是人工真值池 (few-shot 锚定 + 一致率报表的对照组), 机器写入会把尺子校歪。
 *   3. live 有三重安全阀: confidence 阈值 / 每租户日上限 / 10% 随机抽检标记(spotCheck)。
 *
 * 状态机动作与 routes/today.ts 的 /today/approve、/today/reject 同款转换
 * (needs_review→generated / needs_review→draft, optimistic lock), 只是不落校准样本。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, journals } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import {
  checkCompliance,
  checkTitleBodyConsistency,
  checkTitleDataConsistency,
} from "../compliance/content-check.js";
import { transitionStatus, InvalidTransitionError } from "../articles/state-machine.js";
import {
  isEligibleForAiReview,
  buildFewShotBlock,
  parseVerdict,
  isUnderDailyCap,
  decideLiveAction,
  type CalibrationSampleLite,
  type AiVerdict,
} from "./ai-reviewer-rules.js";

const BJ_OFFSET_MS = 8 * 3600_000;

function startOfTodayBJ(): Date {
  const bj = new Date(Date.now() + BJ_OFFSET_MS);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - BJ_OFFSET_MS);
}

export type AiReviewerMode = "off" | "shadow" | "live";

export interface AiReviewRecord {
  verdict: AiVerdict;
  confidence: number;
  reason: string;
  mode: AiReviewerMode | "shadow_cap"; // shadow_cap = live 想动但日上限已满, 只记建议
  checkedAt: string;
  model?: string;
  deterministicFail?: string; // 确定性核验没过的说明 (此时 verdict 恒 unsure)
  fewShotUsed?: { accept: number; reject: number };
  actioned?: boolean;   // live 真的动了状态
  spotCheck?: boolean;  // live approve 的 10% 随机抽检标记
}

export interface AiReviewScanResult {
  mode: AiReviewerMode;
  scanned: number;
  reviewed: number;
  approved: number;
  rejected: number;
  unsure: number;
  held: number; // live 下想动但被阈值/日上限拦下
  errors: number;
}

/** few-shot: 查最近的人工校准样本 (calibration.source=human; 历史样本无 source 字段 = 也是人工, 兼容) */
async function loadHumanCalibrationSamples(limit = 40): Promise<CalibrationSampleLite[]> {
  const rows = await db
    .select({ title: contents.title, metadata: contents.metadata })
    .from(contents)
    .where(sql`${contents.metadata} ? 'calibration' AND COALESCE(${contents.metadata}->'calibration'->>'source', 'human') = 'human'`)
    .orderBy(desc(contents.updatedAt))
    .limit(limit);
  const out: CalibrationSampleLite[] = [];
  for (const r of rows) {
    const cal = ((r.metadata ?? {}) as Record<string, any>).calibration as Record<string, any> | undefined;
    if (!cal || (cal.verdict !== "accept" && cal.verdict !== "reject")) continue;
    out.push({
      verdict: cal.verdict,
      reason: cal.reason ?? null,
      sixDimTotal: cal.sixDimTotal ?? null,
      title: r.title,
      at: cal.at ?? null,
    });
  }
  return out;
}

/** 确定性核验三件复跑 (防漏保险): 标题-正文一致性 / 标题数字 DB 校验 / 违禁承诺话术词表 */
async function runDeterministicChecks(c: {
  title: string | null;
  body: string | null;
  metadata: Record<string, any> | null;
}): Promise<{ ok: boolean; detail: string }> {
  const tc = checkTitleBodyConsistency(c.title, c.body);
  if (!tc.ok) return { ok: false, detail: `标题-正文矛盾: 标题[${tc.titleHits.join("/")}] vs 正文风险信号[${tc.riskSignal}]` };

  let dbFields: import("../compliance/content-check.js").TitleDataDbFields | undefined;
  const journalId = c.metadata?.journalId;
  if (typeof journalId === "string" && journalId) {
    try {
      // 7-20: 多取 IF/复合IF/分区 供标题编造校验
      const [jr] = await db
        .select({ reviewCycle: journals.reviewCycle, acceptanceRate: journals.acceptanceRate, impactFactor: journals.impactFactor, compositeImpactFactor: journals.compositeImpactFactor, partition: journals.partition, casPartition: journals.casPartition, casPartitionNew: journals.casPartitionNew, jcrFull: journals.jcrFull })
        .from(journals).where(eq(journals.id, journalId)).limit(1);
      if (jr) dbFields = { reviewCycle: jr.reviewCycle, acceptanceRate: jr.acceptanceRate, impactFactor: jr.impactFactor, compositeImpactFactor: jr.compositeImpactFactor, partition: jr.partition, casPartition: jr.casPartition, casPartitionNew: jr.casPartitionNew, jcrFull: jr.jcrFull };
    } catch { /* 查库失败按无 DB 字段兜底 (仅正文复现校验) */ }
  }
  const td = checkTitleDataConsistency(c.title, c.body, dbFields);
  if (!td.ok) return { ok: false, detail: `标题数字无据(疑编造): ${JSON.stringify(td.mismatches).slice(0, 160)}` };

  const comp = await checkCompliance(`${c.title ?? ""}\n${c.body ?? ""}`);
  if (comp.blocked) return { ok: false, detail: `违禁硬词命中: ${comp.hardHits.join("、")}` };
  if (comp.softHits.length > 0) return { ok: false, detail: `承诺/绝对化话术命中: ${comp.softHits.slice(0, 5).join("、")}` };

  return { ok: true, detail: "" };
}

function buildReviewPrompt(params: {
  title: string;
  body: string;
  metadata: Record<string, any>;
  fewShotBlock: string;
}): { systemPrompt: string; message: string } {
  const md = params.metadata;
  const dims = (md.sixDimScores ?? {}) as Record<string, any>;
  const dimLines = Object.entries(dims)
    .map(([k, v]: [string, any]) => `- ${k}: ${v?.score ?? "?"}/10${v?.fixHint ? ` (改法: ${String(v.fixHint).slice(0, 60)})` : ""}`)
    .join("\n");
  const weak = Array.isArray(md.sixDimWeak)
    ? md.sixDimWeak.map((w: any) => `- ${w.label} ${w.score}/10 → ${w.fixHint ?? ""}`).join("\n")
    : "";
  // 评分同款去噪: 剥 SVG/style, 控预算 (复审不需要全量 HTML)
  const bodyView = params.body
    .replace(/<svg[\s\S]*?<\/svg>/gi, "【图表】")
    .replace(/\sstyle="[^"]*"/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 6000);

  const systemPrompt = [
    "你是公众号内容终审员, 替总编\"老韩\"复审一篇被六维质检判为灰区(60-79分)的文章。",
    "你的任务: 判断这篇能不能直接发。不是重新打分, 是做\"采用/驳回/存疑\"的裁决。",
    params.fewShotBlock || "【注意】当前没有人工历史裁决可参照, 请采用保守通用标准: 只有把握很大时才 approve, 拿不准一律 unsure。",
    "",
    "裁决标准:",
    "- approve: 内容真实、数据口径一致、无过度承诺、读者能得到实用信息 — 瑕疵是小的(排版/语气), 可以发。",
    "- reject: 有实质问题(数据可疑/空洞凑字/误导倾向), 修比发强。",
    "- unsure: 拿不准, 留给人工。宁 unsure 勿错放。",
    "",
    '只输出 JSON (不要 markdown 包裹): {"verdict": "approve|reject|unsure", "confidence": 0.0-1.0, "reason": "一句话理由(中文, ≤100字)"}',
  ].join("\n");

  const message = [
    `【标题】${params.title}`,
    `【六维总分】${md.sixDimTotal ?? "?"} / 100 (发布线 80)`,
    dimLines ? `【六维明细】\n${dimLines}` : "",
    weak ? `【失败维度与修改提示】\n${weak}` : "",
    `【正文(去格式)】\n${bodyView}`,
  ].filter(Boolean).join("\n\n");

  return { systemPrompt, message };
}

/** 该租户今日已被 live 自动裁决(actioned)的条数 — 日上限安全阀的分母 */
async function countActionedToday(tenantId: string): Promise<number> {
  const since = startOfTodayBJ().toISOString();
  const res = await db.execute(sql`
    SELECT COUNT(*) AS n FROM contents
    WHERE tenant_id = ${tenantId}::uuid
      AND metadata->'aiReview'->>'actioned' = 'true'
      AND metadata->'aiReview'->>'checkedAt' >= ${since}
  `);
  return Number(((res as any).rows?.[0]?.n) ?? 0);
}

/** 裁决落 metadata.aiReview (jsonb 顶层 merge, 与 calibration 同款 idiom; 但 key 不同, 互不覆盖) */
async function writeAiReview(contentId: string, record: AiReviewRecord, extra?: Record<string, unknown>): Promise<void> {
  const patch: Record<string, unknown> = { aiReview: record, ...(extra ?? {}) };
  await db.update(contents)
    .set({ metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(contents.id, contentId));
}

/**
 * 扫一轮: 取最新的 needs_review 文章 → 入池过滤 → 确定性核验 → LLM 复审 → 落 aiReview (live 才动状态)。
 * 每轮 ≤ limit 篇 (默认 20, 控 token 成本); 单篇失败只记日志跳过。
 */
export async function runAiReviewScan(opts?: {
  limit?: number;
  mode?: AiReviewerMode;
}): Promise<AiReviewScanResult> {
  const mode: AiReviewerMode = opts?.mode ?? env.AI_REVIEWER_MODE;
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const result: AiReviewScanResult = { mode, scanned: 0, reviewed: 0, approved: 0, rejected: 0, unsure: 0, held: 0, errors: 0 };
  if (mode === "off") return result;

  // 候选: 全库最新待审文章 (含 SYSTEM 推荐池; 按租户的日上限在 live 动作处控)
  const candidates = await db
    .select({
      id: contents.id, tenantId: contents.tenantId, title: contents.title,
      body: contents.body, status: contents.status, metadata: contents.metadata,
    })
    .from(contents)
    .where(and(eq(contents.status, "needs_review"), inArray(contents.type, ["article"])))
    .orderBy(desc(contents.createdAt))
    .limit(200);
  result.scanned = candidates.length;

  const pool = candidates.filter((c) => isEligibleForAiReview({ status: c.status, metadata: c.metadata as Record<string, unknown> | null }).eligible).slice(0, limit);
  if (pool.length === 0) {
    logger.info({ scanned: result.scanned, mode }, "AI 审稿: 本轮无灰区待审文章");
    return result;
  }

  // few-shot 人工锚定 (全局池: 老韩的标准是全局的, 不分租户)
  const samples = await loadHumanCalibrationSamples();
  const fewShot = buildFewShotBlock(samples);

  const minConfidence = env.AI_REVIEWER_MIN_CONFIDENCE;
  const dailyCap = env.AI_REVIEWER_DAILY_CAP;
  const capCache = new Map<string, number>(); // tenantId → 今日已 actioned 数

  for (const c of pool) {
    try {
      const md = (c.metadata ?? {}) as Record<string, any>;
      const checkedAt = new Date().toISOString();

      // a) 确定性核验三件复跑 — 任一不过 → unsure 留人, 不烧 LLM
      const det = await runDeterministicChecks({ title: c.title, body: c.body, metadata: md });
      if (!det.ok) {
        await writeAiReview(c.id, {
          verdict: "unsure", confidence: 0,
          reason: `确定性核验未过: ${det.detail}`.slice(0, 300),
          mode, checkedAt, deterministicFail: det.detail.slice(0, 200),
          fewShotUsed: fewShot.used,
        });
        result.reviewed++; result.unsure++;
        continue;
      }

      // b) LLM 复审 (chat-service → Qwen/DeepSeek, 红线 #3)
      const { systemPrompt, message } = buildReviewPrompt({
        title: c.title ?? "(无标题)", body: c.body ?? "", metadata: md, fewShotBlock: fewShot.block,
      });
      const resp = await chat({
        tenantId: c.tenantId, userId: "system", conversationId: `ai-review-${c.id}`,
        message, systemPrompt, skillType: "quality_check",
      });
      const parsed = parseVerdict(resp.content);

      // c) live 决策 (shadow 恒 hold)
      let record: AiReviewRecord = {
        verdict: parsed.verdict, confidence: parsed.confidence, reason: parsed.reason,
        mode, checkedAt, model: resp.model, fewShotUsed: fewShot.used,
      };

      if (mode === "live" && parsed.verdict !== "unsure") {
        if (!capCache.has(c.tenantId)) capCache.set(c.tenantId, await countActionedToday(c.tenantId));
        const actioned = capCache.get(c.tenantId)!;
        const underCap = isUnderDailyCap(actioned, dailyCap);
        const decision = decideLiveAction({
          verdict: parsed.verdict, confidence: parsed.confidence,
          minConfidence, underCap, hasFewShot: fewShot.hasSamples,
        });
        record.confidence = decision.effectiveConfidence;
        if (!underCap) record.mode = "shadow_cap"; // 日上限满 → 只记建议

        if (decision.action === "approve") {
          // 与 /today/approve 同款状态机转换 (needs_review → generated), 但不写 calibration
          const spotCheck = Math.random() < 0.1; // 10% 随机抽检标记
          record = { ...record, actioned: true, ...(spotCheck ? { spotCheck: true } : {}) };
          await transitionStatus(c.id, "needs_review", "generated");
          await writeAiReview(c.id, record, { approvedBy: "ai_reviewer" });
          capCache.set(c.tenantId, actioned + 1);
          result.reviewed++; result.approved++;
          logger.info({ contentId: c.id, confidence: record.confidence, spotCheck }, "AI 审稿(live): 自动采用 → generated");
          continue;
        }
        if (decision.action === "reject") {
          record = { ...record, actioned: true };
          await transitionStatus(c.id, "needs_review", "draft");
          await writeAiReview(c.id, record);
          capCache.set(c.tenantId, actioned + 1);
          result.reviewed++; result.rejected++;
          logger.info({ contentId: c.id, confidence: record.confidence }, "AI 审稿(live): 自动驳回 → draft");
          continue;
        }
        result.held++;
      }

      // shadow / live-hold: 只记建议, 状态不动
      await writeAiReview(c.id, record);
      result.reviewed++;
      if (parsed.verdict === "approve") result.approved++;
      else if (parsed.verdict === "reject") result.rejected++;
      else result.unsure++;
    } catch (err) {
      result.errors++;
      if (err instanceof InvalidTransitionError) {
        logger.warn({ contentId: c.id, err: err.message }, "AI 审稿: 状态机 race (可能人工先动了), 跳过");
      } else {
        logger.warn({ contentId: c.id, err: err instanceof Error ? err.message : err }, "AI 审稿: 单篇失败, 跳过");
      }
    }
  }

  logger.info(result, "AI 审稿: 本轮完成");
  return result;
}
