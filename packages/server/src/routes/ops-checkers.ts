/**
 * 检查器裁决接口（8-14 Phase 3 · **只上后端数据路径**）。
 *
 * ## 两段式的前半段
 *
 * 老韩定的节奏：后端现在做，周报里的裁决按钮等「研小二读懂周报」的确认再上。
 * 所以本文件的接口是通的、admin 门控的，但**周报不会提它**，前端也还没有页面。
 * 通了但不喊 —— 等确认到了，前端接上即可，后端不用再动。
 *
 * ## 为什么裁决要人来做
 *
 * 台账能数出「这道闸报了 37 条」，数不出「其中几条报对了」。
 * 没有后一个数，所有去留结论都卡在「台账未成熟」。
 * 而这个判断**恰恰不能交给 LLM** —— 整套台账建起来就是为了摆脱"LLM 评 LLM"。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { requirePermission } from "../middleware/permission.js";
import {
  sampleHitsForAdjudication,
  submitAdjudication,
  adjudicationProgress,
  VERDICTS,
  SAMPLE_SIZE,
  type Verdict,
} from "../services/ops/checker-adjudication.js";
import { summarize, judge, MIN_ADJUDICATED } from "../services/ops/checker-ledger.js";
import { getChecker } from "../services/ops/checker-registry.js";

const submitSchema = z.object({
  checkerId: z.string().min(1).max(80),
  contentId: z.string().uuid(),
  verdict: z.enum(VERDICTS as unknown as [Verdict, ...Verdict[]]),
  note: z.string().max(1000).optional(),
});

export async function opsCheckerRoutes(app: FastifyInstance) {
  /**
   * GET /ops/checkers/sample —— 抽一批待裁决的命中（默认 10 条 ≈ 5 分钟）。
   *
   * 命中是**现算**的，不是查表：你判的就是这道闸今天真会报的东西。
   */
  app.get("/sample", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    const q = request.query as { days?: string; limit?: string; checkerId?: string };
    const annotatorId = (request as { user?: { userId?: string } }).user?.userId ?? null;
    try {
      const hits = await sampleHitsForAdjudication({
        days: q.days ? Math.min(90, Math.max(1, Number(q.days))) : 14,
        limit: q.limit ? Math.min(50, Math.max(1, Number(q.limit))) : SAMPLE_SIZE,
        ...(q.checkerId ? { checkerId: q.checkerId } : {}),
        annotatorId,
      });
      return reply.send({ success: true, data: { hits, sampleSize: SAMPLE_SIZE } });
    } catch (err) {
      logger.error({ err }, "ops_checkers.sample_failed");
      return reply.status(500).send({ success: false, error: "抽样失败" });
    }
  });

  /**
   * POST /ops/checkers/adjudicate —— 判一条：拦对了 / 拦错了 / 本该拦没拦。
   *
   * 改判会先撤旧票再投新票（台账是计数器，不撤就等于一个人投了两票）。
   */
  app.post("/adjudicate", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "参数不合法", detail: parsed.error.issues });
    }
    const annotatorId = (request as { user?: { userId?: string } }).user?.userId ?? null;
    try {
      const r = await submitAdjudication({ ...parsed.data, annotatorId });
      return reply.send({ success: true, data: r });
    } catch (err) {
      logger.error({ err, body: parsed.data }, "ops_checkers.adjudicate_failed");
      return reply.status(500).send({ success: false, error: "裁决落库失败" });
    }
  });

  /**
   * GET /ops/checkers/status —— 每道闸的台账 + 裁决进度 + 当前判定。
   *
   * 「还差几票才能下结论」是这个接口存在的主要理由：没有它，
   * 裁决的人不知道自己判的那 10 条离「够用」还有多远。
   */
  app.get("/status", { preHandler: requirePermission("content.read") }, async (_request, reply) => {
    try {
      const [stats, progress] = await Promise.all([summarize(4), adjudicationProgress()]);
      const byChecker = new Map(progress.map((p) => [p.checkerId, p.total]));
      const data = stats
        .map((s) => {
          const v = judge(s);
          const def = getChecker(s.checkerId);
          return {
            checkerId: s.checkerId,
            guards: def?.guards ?? "(未注册)",
            mode: def?.mode ?? "unknown",
            evaluated: s.evaluated,
            hits: s.hits,
            adjudicated: s.adjudicated,
            votesCast: byChecker.get(s.checkerId) ?? 0,
            /** 还差几票才够下结论 —— 判定门槛见 checker-ledger.MIN_ADJUDICATED */
            votesNeeded: Math.max(0, MIN_ADJUDICATED - s.adjudicated),
            level: v.level,
            message: v.message,
            action: v.action,
          };
        })
        .sort((a, b) => b.hits - a.hits);
      return reply.send({ success: true, data });
    } catch (err) {
      logger.error({ err }, "ops_checkers.status_failed");
      return reply.status(500).send({ success: false, error: "查询失败" });
    }
  });
}
