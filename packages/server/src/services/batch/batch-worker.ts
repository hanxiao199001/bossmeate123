/**
 * P4 batch-worker（5-12 backend Day 1）。
 *
 * 处理流程：
 *   1. 从 batch_rows 拿 row 详情
 *   2. transitionStatus(null, 'draft') 等价 — INSERT contents row
 *   3. transitionStatus('draft', 'generating')
 *   4. 调 ArticleSkill.handle (走 collector V6 + 模板 + 生成 article body)
 *   5. 成功: transitionStatus('generating', 'generated') + updateRowProgress
 *   6. 失败: 自动 retry 3 次指数退避（30s/2min/5min）
 *      满 3 次 → transitionStatus('generating', 'failed', errorMessage) + updateRowProgress
 *
 * 强依赖 P0 状态机。
 */
import { Worker, Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { batchRows, contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import {
  initialStatusFields,
  transitionStatus,
  InvalidTransitionError,
} from "../articles/state-machine.js";
import { SkillRegistry } from "../skills/index.js";
import { getRedisConnection } from "../task/queue.js";
import {
  BATCH_WORKER_CONCURRENCY,
  BATCH_RETRY_DELAYS_MS,
  BATCH_MAX_AUTO_RETRY,
  batchQueue,
} from "./queue.js";
import { updateRowProgress } from "./batch-service.js";

interface BatchRowJob {
  batchId: string;
  rowId: string;
  tenantId: string;
  userId: string;
  isRetry?: boolean;
  autoRetryCount?: number;
}

let worker: Worker<BatchRowJob> | null = null;

export function startBatchWorker(): Worker<BatchRowJob> {
  if (worker) {
    logger.warn("P4 batch worker 已启动，跳过");
    return worker;
  }

  worker = new Worker<BatchRowJob>(
    "batch-csv",
    async (job: Job<BatchRowJob>) => {
      const { batchId, rowId, tenantId, userId, autoRetryCount = 0 } = job.data;
      logger.info({ batchId, rowId, autoRetryCount }, "P4 batch row pickup");

      // 1. load row + 校验
      const [row] = await db.select().from(batchRows).where(eq(batchRows.id, rowId)).limit(1);
      if (!row) {
        logger.warn({ rowId }, "P4 batch row 不存在，跳过");
        return;
      }

      // 2. INSERT contents (status='draft') — initialStatusFields 走状态机初始化
      const [content] = await db
        .insert(contents)
        .values({
          tenantId,
          userId,
          type: "article",
          title: row.topic,
          ...initialStatusFields("draft"),
          metadata: {
            batchId,
            batchRowId: rowId,
            template: row.template,
            ...(row.journalId ? { journalId: row.journalId } : {}),
          },
        })
        .returning({ id: contents.id });
      if (!content) throw new Error("contents insert 失败");

      // 3. draft → generating
      try {
        await transitionStatus(content.id, "draft", "generating");
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }
      await updateRowProgress(rowId, "generating", { articleId: content.id });

      // 4. 调 ArticleSkill 真生成（同步 / 用 retry 包）
      const article = SkillRegistry.get("article");
      if (!article) throw new Error("ArticleSkill 未注册");

      try {
        // PR-X1: 行绑定了账号(独家模式) → 注入该账号的人设/风格画像
        let personaPrompt = "";
        if ((row as { accountId?: string | null }).accountId) {
          try {
            const { platformAccounts } = await import("../../models/schema.js");
            const [acct] = await db
              .select({ persona: platformAccounts.persona, styleProfile: platformAccounts.styleProfile })
              .from(platformAccounts)
              .where(eq(platformAccounts.id, (row as { accountId?: string }).accountId!))
              .limit(1);
            if (acct) {
              const { buildPersonaSuffix } = await import("../skills/structure-variation.js");
              personaPrompt = buildPersonaSuffix(acct.persona, acct.styleProfile);
            }
          } catch { /* 人设注入失败不影响生成 */ }
        }
        const skillContext = {
          tenantId,
          user: { userId, role: "owner" }, // batch 用 system user 默认 owner 权限
          metadata: {
            templateId: mapTemplateLetter(row.template),
            ...(row.journalId ? { journalId: row.journalId } : {}),
            ...(personaPrompt ? { personaPrompt } : {}),
          },
        };
        // ArticleSkill.handle 是 conversation-driven (含发布等流程)，batch 路径用直接生成
        // 简化：用 row.topic 作 user input，复用 handle 流程（生成完写 contents body）
        const result = await (article as { handle: (input: string, history: unknown[], ctx: unknown) => Promise<{ reply: string; artifact?: { body: string; title?: string } }> })
          .handle(row.topic, [], skillContext);

        if (result.artifact?.body) {
          // 5-23 hotfix #164: merge artifact.metadata 进 contents.metadata
          // 之前只 set body+title, artifact.metadata (含 PR #162 hasWarnings/validatorIssues + qualityScore 等) 全丢
          // 用 jsonb_set / || merge 保住老 metadata (batchId/journalId/...) + 加新 artifact 字段
          const artMeta = (result.artifact as { metadata?: Record<string, unknown> }).metadata || {};
          // 只 cherry-pick 有意义的字段, 防 LLM artifact 杂字段污染 contents.metadata
          // PR #242 (5-23): 加 videoScript — PR #241 输出该字段, bridge 读 metadata.videoScript
          //   触发 DVH 90 秒视频朗读. 缺则 fallback 老 extractNarration (title + body 前 80 字).
          const metaMerge: Record<string, unknown> = {};
          for (const k of ["hasWarnings", "validatorIssues", "qualityScore", "qualityPassed", "aiScore", "hardMetrics", "templateId", "videoScript", "variationRecipe"]) {
            if (artMeta[k] !== undefined) metaMerge[k] = artMeta[k];
          }
          await db
            .update(contents)
            .set({
              body: result.artifact.body,
              title: result.artifact.title ?? row.topic,
              metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify(metaMerge)}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(contents.id, content.id));
        }

        // 5. PR-U2 质检前置: 质检明确未过 → needs_review(待审, 不进可发); 否则 generated
        const artMetaForGate = (result.artifact as { metadata?: Record<string, unknown> } | undefined)?.metadata || {};
        const qPassed = artMetaForGate.qualityPassed;
        const qScore = typeof artMetaForGate.qualityScore === "number" ? artMetaForGate.qualityScore : undefined;
        // PR-U2(调) 只在质检明确判不通过时转待审; 尊重原质检结论, 不再用分数二次卡(过严会误伤)
        const failed = qPassed === false;
        if (failed) {
          await transitionStatus(content.id, "generating", "needs_review");
          await db.update(contents)
            .set({ metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify({ needsReview: true })}::jsonb` })
            .where(eq(contents.id, content.id));
          await updateRowProgress(rowId, "generated", { articleId: content.id, errorMessage: null });
          logger.info({ rowId, contentId: content.id, qScore }, "PR-U2 质检未过, 转 needs_review 待人工复核");
        } else {
          await transitionStatus(content.id, "generating", "generated");
          await updateRowProgress(rowId, "generated", { articleId: content.id, errorMessage: null });
          logger.info({ rowId, contentId: content.id }, "P4 batch row 生成成功");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ rowId, err: msg, autoRetryCount }, "P4 batch row 生成失败");

        // 自动 retry 指数退避
        if (autoRetryCount < BATCH_MAX_AUTO_RETRY) {
          const delay = BATCH_RETRY_DELAYS_MS[autoRetryCount] ?? BATCH_RETRY_DELAYS_MS[BATCH_RETRY_DELAYS_MS.length - 1];
          // 状态机：generating → failed → generating（满足 spec 转移规则）
          try {
            await transitionStatus(content.id, "generating", "failed", { errorMessage: msg });
            await transitionStatus(content.id, "failed", "generating");
          } catch {}
          await batchQueue.add(
            "batch-row",
            { batchId, rowId, tenantId, userId, isRetry: true, autoRetryCount: autoRetryCount + 1 },
            { delay, jobId: `batch-${batchId}-${rowId}-auto-${autoRetryCount + 1}` },
          );
          logger.info({ rowId, delay, nextAutoRetry: autoRetryCount + 1 }, "P4 batch row 自动 retry 已入队");
          return;
        }

        // 满 3 次 → final failed
        try {
          await transitionStatus(content.id, "generating", "failed", { errorMessage: msg });
        } catch {}
        await updateRowProgress(rowId, "failed", { articleId: content.id, errorMessage: msg });
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: BATCH_WORKER_CONCURRENCY,
      lockDuration: 10 * 60 * 1000, // 10 min（生成单篇可能 1-2 min）
    },
  );

  worker.on("error", (err) => logger.error({ err }, "P4 batch worker error"));
  logger.info({ concurrency: BATCH_WORKER_CONCURRENCY }, "P4 batch worker 已启动 ✅");
  return worker;
}

export async function stopBatchWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("P4 batch worker 已停止");
  }
}

/** csv 'A/B/C/E' → templateId（Q.2 4 模板）。null → undefined（caller 走 default） */
function mapTemplateLetter(letter: string | null): string | undefined {
  if (!letter) return undefined;
  const map: Record<string, string> = {
    A: "shunshi-style",
    B: "marketing-conversion",
    C: "popular-science",
    E: "industry-vertical",
  };
  return map[letter.toUpperCase()];
}
