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
import { eq, sql, and, isNull } from "drizzle-orm";
import { db } from "../../models/db.js";
import { batchRows, contents, journalUsage } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { sanitizeForCompliance } from "../compliance/content-check.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { isUnverifiedJournal } from "../journals/verification.js";
import {
  initialStatusFields,
  transitionStatus,
  InvalidTransitionError,
} from "../articles/state-machine.js";
import { SkillRegistry } from "../skills/index.js";
import { runWithLlmCallAttribution } from "../billing/llm-cost.js";
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

/**
 * 7-28 ②d: "质检闸没跑成"落 ops_incidents(旁路, 绝不影响生产)。
 *
 * 为什么要单独一类而不是复用 quality_check_unavailable: 后者的语义是"评分模型挂了, 这篇没评上分";
 * 这里是"流水线/一致性校验整段抛异常, 这篇压根没被检查"。两者的排查方向完全不同
 * (一个查 AI 额度/超时, 一个查代码异常/DB), 混一类会让简报给出错误的处置建议。
 *
 * 节流: 一次故障(如 DB 抖动)会连撞一整批, 10 分钟一条即可; 被压掉的次数带在 detail 里。
 */
function reportGateIncident(tenantId: string, contentId: string, reason: string, error: string): void {
  void (async () => {
    try {
      const { recordIncidentThrottled } = await import("../ops/incidents.js");
      await recordIncidentThrottled({
        kind: "quality_gate_unavailable",
        severity: "warn",
        tenantId,
        message: `生成后质检闸未跑成(${reason}): ${error.slice(0, 200)} — 该篇已转人工复核(不是内容有问题)`,
        detail: { contentId, stage: "batch_worker", reason, error: error.slice(0, 300) },
      }, { key: `quality_gate_unavailable:batch:${reason}` });
    } catch { /* 告警旁路 */ }
  })();
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

      // 1.5 —— 7-27 无人值守③: LLM 日花费/日调用硬上限(billing/llm-guard)。
      //   这里是**真正烧钱的地方**(每篇 6-10 次 LLM 调用), daily-cron 只在排产时查一次,
      //   队列里已排进来的行必须在开工前再拦一道, 否则熔断后已入队的几十行照烧不误。
      //   触顶 → 行标 failed(带人话原因, 明天可到批次页 retry), 不 throw(避免 BullMQ 重试风暴)。
      //   AI 客服/对话链路不经过这里, 天然豁免。fail-open: 闸自身异常放行(见 llm-guard 文件头)。
      try {
        const { checkLlmDailyCap } = await import("../billing/llm-guard.js");
        const cap = await checkLlmDailyCap();
        if (!cap.allowed) {
          logger.error({ rowId, usage: cap.usage }, "🛑 LLM 日上限熔断 — 本行不生成(明天零点自动解封, 可 retry)");
          await updateRowProgress(rowId, "failed", {
            errorMessage: `LLM 日上限熔断, 今日停产保余额: ${(cap.reason ?? "").slice(0, 300)}`,
          });
          return;
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err }, "LLM 日上限检查异常, 放行(fail-open)");
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
        // 6-22: 并把绑定写进 content.metadata.exclusiveAccountId, 让分发直派该号(不被同领域别号抢走)。
        let personaPrompt = "";
        const boundAccountId = (row as { accountId?: string | null }).accountId || null;
        if (boundAccountId) {
          try {
            await db.update(contents)
              .set({ metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify({ exclusiveAccountId: boundAccountId })}::jsonb`, updatedAt: new Date() })
              .where(eq(contents.id, content.id));
          } catch { /* 绑定写入失败不影响生成 */ }
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
            batchId, // 7-03 ④: 钩子/措辞批次内轮换 scope
            ...(boundAccountId ? { accountId: boundAccountId } : {}),
            ...(row.journalId ? { journalId: row.journalId } : {}),
            ...(personaPrompt ? { personaPrompt } : {}),
          },
        };
        // ArticleSkill.handle 是 conversation-driven (含发布等流程)，batch 路径用直接生成
        // 简化：用 row.topic 作 user input，复用 handle 流程（生成完写 contents body）
        // PR-Q6 整篇硬超时(釜底抽薪): 任何环节(补数据/LLM/渲染)卡住超 180s 即快速失败, 不再干等到10分钟看门狗。
        const GEN_HARD_TIMEOUT_MS = 180_000;
        const result = await Promise.race([
          // 7-06 成本归属: ALS 把批次租户带给 RoutedProvider→chat() 记账(见 billing/llm-cost)
          runWithLlmCallAttribution({ tenantId, userId, conversationId: `batch-${batchId}` }, () =>
            (article as { handle: (input: string, history: unknown[], ctx: unknown) => Promise<{ reply: string; artifact?: { body: string; title?: string } }> })
              .handle(row.topic, [], skillContext)),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("生成超时(180秒) — 可能补期刊数据或模型响应卡住, 请重试")), GEN_HARD_TIMEOUT_MS)),
        ]);

        if (result.artifact?.body) {
          // 5-23 hotfix #164: merge artifact.metadata 进 contents.metadata
          // 之前只 set body+title, artifact.metadata (含 PR #162 hasWarnings/validatorIssues + qualityScore 等) 全丢
          // 用 jsonb_set / || merge 保住老 metadata (batchId/journalId/...) + 加新 artifact 字段
          const artMeta = (result.artifact as { metadata?: Record<string, unknown> }).metadata || {};
          // 只 cherry-pick 有意义的字段, 防 LLM artifact 杂字段污染 contents.metadata
          // PR #242 (5-23): 加 videoScript — PR #241 输出该字段, bridge 读 metadata.videoScript
          //   触发 DVH 90 秒视频朗读. 缺则 fallback 老 extractNarration (title + body 前 80 字).
          const metaMerge: Record<string, unknown> = {};
          // 7-28 阶段1-C: promptVersion 必须在白名单里, 否则 ArticleSkill 写的版本号会被这层过滤掉,
          //   落库的内容又变成"不知道是哪版 prompt 写的"(见 prompt-version.ts)。
          for (const k of ["hasWarnings", "validatorIssues", "qualityScore", "qualityPassed", "aiScore", "hardMetrics", "templateId", "videoScript", "variationRecipe", "promptVersion"]) {
            if (artMeta[k] !== undefined) metaMerge[k] = artMeta[k];
          }
          await db
            .update(contents)
            .set({
              body: sanitizeForCompliance(result.artifact.body), // 6-19 生成阶段净化违禁/绝对化词
              title: result.artifact.title ?? row.topic,
              metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify(metaMerge)}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(contents.id, content.id));

          // 6-25 标题DNA: 有期刊时, 用"该号风格的标题生成器"覆盖标题(更像该号写的)。失败保留原标题, 不阻塞。TITLE_GEN_ENABLED=0 可关。
          if (process.env.TITLE_GEN_ENABLED !== "0" && row.journalId) {
            try {
              const { generateTitles } = await import("../content-engine/title-generator.js");
              const { journals, platformAccounts } = await import("../../models/schema.js");
              const [jr] = await db.select({
                name: journals.name, nameEn: journals.nameEn, publisher: journals.publisher,
                casPartition: journals.casPartitionNew, jcrSubjects: journals.jcrSubjects,
                impactFactor: journals.impactFactor, reviewCycle: journals.reviewCycle,
                acceptanceRate: journals.acceptanceRate, selfCitationRate: journals.selfCitationRate, discipline: journals.discipline,
                catalogs: journals.catalogs, cscdLevel: journals.cscdLevel, // 7-21: 判国内刊 + 身份卖点
              }).from(journals).where(eq(journals.id, row.journalId)).limit(1);
              let styleProfile: string | undefined;
              let acctPersona: string | undefined; // 7-03 ④: 人设分级(编辑号禁狠话/营销号放开)
              if (boundAccountId) {
                const [acct] = await db.select({ s: platformAccounts.styleProfile, p: platformAccounts.persona }).from(platformAccounts).where(eq(platformAccounts.id, boundAccountId)).limit(1);
                styleProfile = acct?.s ?? undefined;
                acctPersona = acct?.p ?? undefined;
              }
              if (jr) {
                const titles = await generateTitles({
                  tenantId, userId, styleProfile, count: 3,
                  persona: acctPersona, // 7-03 ④ 人设分级
                  rotationScope: batchId, // 7-03 ④ 本批内"闭眼冲"等狠话限次轮换
                  journal: {
                    name: jr.name, nameEn: jr.nameEn, publisher: jr.publisher,
                    casPartition: jr.casPartition, jcrPartition: jr.jcrSubjects,
                    impactFactor: jr.impactFactor, reviewCycle: jr.reviewCycle,
                    acceptanceRate: jr.acceptanceRate, selfCitationRate: jr.selfCitationRate, discipline: jr.discipline,
                    catalogs: jr.catalogs as string[] | null, cscdLevel: jr.cscdLevel, // 7-21: 国内刊标题口径
                  },
                });
                if (titles[0]) {
                  await db.update(contents).set({ title: titles[0], updatedAt: new Date() }).where(eq(contents.id, content.id));
                  logger.info({ contentId: content.id, title: titles[0] }, "6-25 标题DNA已覆盖标题");
                }
              }
            } catch (e) {
              logger.warn({ contentId: content.id, err: e instanceof Error ? e.message : e }, "标题DNA生成失败, 保留原标题");
            }
          }
        }

        // 4.5 P0四件套(7-03): ④压缩→③去AI腔→①六维质检+定向重写闭环。
        // 为什么接在这里而不是 ArticleSkill.handle 内: handle 被 180s 硬超时包裹,
        // 四件套的 2-4 次 LLM 调用会把正常生成挤爆超时; 放在超时圈外, 生成成功后再提质。
        // 铁律: 流水线任何失败只 warn, 文章按现状继续走, 绝不让提质把生产打挂。
        let sixDimPassedGate: boolean | null = null;
        let sixDimDegraded = false; // 7-03: 评分器两次均降级 → needs_review 标 degraded(区别于"质量不过"), 首过率统计排除
        // 7-28 ②d: 质检流水线**整条抛异常**时, 原来 sixDimPassedGate 保持 null, 而下面的判据是
        //   `sixDimPassedGate === false` 才转待审 —— null 等于通过, 于是"质检根本没跑"的文章
        //   直接 status=generated 进可发池。异常 ≠ 通过。现在标 gateUnavailable, 转 needs_review,
        //   reason = quality_gate_unavailable(**非红线**: 进草稿箱但排队尾, 见 draft-distributor)。
        let gateUnavailable: string | null = null;
        try {
          const { runArticleQualityPasses, qualityPipelineMeta } = await import("../content-engine/quality-pipeline.js");
          const [cur] = await db
            .select({ body: contents.body, title: contents.title })
            .from(contents)
            .where(eq(contents.id, content.id))
            .limit(1);
          if (cur?.body) {
            const qp = await runArticleQualityPasses({
              tenantId,
              userId,
              title: cur.title ?? row.topic,
              body: cur.body,
              contentId: content.id, // 7-27: 质检告警带上是哪一篇, 简报能直接点开
              ...(row.journalId ? { journalId: row.journalId } : {}),
            });
            const meta = qualityPipelineMeta(qp);
            await db
              .update(contents)
              .set({
                ...(qp.changed ? { body: qp.body } : {}),
                metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
                updatedAt: new Date(),
              })
              .where(eq(contents.id, content.id));
            sixDimPassedGate = qp.qualityLoop.passed;
            sixDimDegraded = qp.sixDim?.degraded ?? false;
            logger.info(
              { contentId: content.id, sixDimTotal: qp.qualityLoop.finalTotal, rounds: qp.qualityLoop.rounds, passed: qp.qualityLoop.passed, llmCalls: qp.llmCalls },
              "P0四件套: batch 路径提质完成"
            );
          } else {
            // 7-28 ②d(顺手捞到的第三处 open): 正文为空 → 质检整段被跳过, 而旧代码随后照样
            //   transitionStatus(→"generated") —— 一篇空文章就这样进了可发池。
            //   空正文既跑不了质检、本身也不是能发的内容, 一律转人工。
            gateUnavailable = "empty_body";
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          gateUnavailable = "quality_pipeline_error";
          logger.warn({ contentId: content.id, err: msg }, "7-28 P0四件套流水线异常 → 判「质检没跑成」转 needs_review(异常 ≠ 通过)");
          reportGateIncident(tenantId, content.id, "quality_pipeline_error", msg);
        }

        // 5. PR-U2 质检前置: 质检明确未过 → needs_review(待审, 不进可发); 否则 generated
        const artMetaForGate = (result.artifact as { metadata?: Record<string, unknown> } | undefined)?.metadata || {};
        const qPassed = artMetaForGate.qualityPassed;
        const qScore = typeof artMetaForGate.qualityScore === "number" ? artMetaForGate.qualityScore : undefined;
        // 7-03/7-05 标题-正文一致性: ①正文有风险信号却标题喊保录(行7) ②标题审稿/录用率数字正文无据(行1 编造) → 信任事故, 转 needs_review
        let titleBodyBad: { reason: string; detail: unknown } | null = null;
        try {
          const { checkTitleBodyConsistency, checkTitleDataConsistency } = await import("../compliance/content-check.js");
          const [fin] = await db.select({ title: contents.title, body: contents.body }).from(contents).where(eq(contents.id, content.id)).limit(1);
          // 7-05: 取 DB 审稿周期/录用率做硬校验(字段空→标题该数字必是编造, 治行4 一致编造绕过正文复现)
          let dbFields: import("../compliance/content-check.js").TitleDataDbFields | undefined;
          let unverifiedSrc: { confidence: number | null; dataSource: string | null } | null = null;
          if (row.journalId) {
            const { journals: journalsTbl } = await import("../../models/schema.js");
            // 7-20: 多取 IF/复合IF/分区 供标题编造校验(国内刊这些字段常空 → 标题里出现即编造)
            // 7-28 ③c 解冻国内刊的关键一步: isUnverifiedJournal 走的是 toJournalKind + isCnVerified,
            //   判国内刊靠的是**目录成员资格 + 刊号实体确认**(catalogs / cscd_level / pku_core_level /
            //   catalog_type / cn_number+publisher)。这里若只投影 confidence/dataSource, 那几列一律 undefined
            //   → 国内刊必然落回 isIntlVerified 那把国际尺子 → 88% 判未核实 → 内容照旧全标 needs_review,
            //   解冻只体现在"选的刊更对口"、发不出去。所以投影必须覆盖判定读的全部字段。
            const [jr] = await db.select({ reviewCycle: journalsTbl.reviewCycle, acceptanceRate: journalsTbl.acceptanceRate, impactFactor: journalsTbl.impactFactor, compositeImpactFactor: journalsTbl.compositeImpactFactor, partition: journalsTbl.partition, casPartition: journalsTbl.casPartition, casPartitionNew: journalsTbl.casPartitionNew, jcrFull: journalsTbl.jcrFull, confidence: journalsTbl.confidence, dataSource: journalsTbl.dataSource, catalogs: journalsTbl.catalogs, cscdLevel: journalsTbl.cscdLevel, pkuCoreLevel: journalsTbl.pkuCoreLevel, catalogType: journalsTbl.catalogType, cnNumber: journalsTbl.cnNumber, publisher: journalsTbl.publisher }).from(journalsTbl).where(eq(journalsTbl.id, row.journalId)).limit(1);
            if (jr) {
              dbFields = { reviewCycle: jr.reviewCycle, acceptanceRate: jr.acceptanceRate, impactFactor: jr.impactFactor, compositeImpactFactor: jr.compositeImpactFactor, partition: jr.partition, casPartition: jr.casPartition, casPartitionNew: jr.casPartitionNew, jcrFull: jr.jcrFull };
              // PR B 未核实源护栏: daily-cron(系统租户)回退选中的 conf<70/legacy_unknown 刊生成的内容 →
              //   标 needs_review, 走 PR#200 发布期硬闸 + 工坊人工复核后才对外(国际 scope 结构上不回退, 不受影响)。
              if (tenantId === SYSTEM_RECOMMENDATION_TENANT_ID && isUnverifiedJournal(jr)) {
                unverifiedSrc = { confidence: jr.confidence, dataSource: jr.dataSource };
              }
            }
          }
          const tc = checkTitleBodyConsistency(fin?.title, fin?.body);
          const td = checkTitleDataConsistency(fin?.title, fin?.body, dbFields);
          if (!tc.ok) { titleBodyBad = { reason: "title_body_inconsistent", detail: { titleHits: tc.titleHits, riskSignal: tc.riskSignal } }; logger.warn({ contentId: content.id, ...tc }, "标题-正文矛盾(标题保录承诺 vs 正文风险信号), 转 needs_review"); }
          else if (!td.ok) { titleBodyBad = { reason: "title_data_fabricated", detail: { mismatches: td.mismatches } }; logger.warn({ contentId: content.id, mismatches: td.mismatches }, "标题数字正文无据(疑编造审稿/录用率), 转 needs_review"); }
          else if (unverifiedSrc) { titleBodyBad = { reason: "unverified_source_journal", detail: unverifiedSrc }; logger.warn({ contentId: content.id, journalId: row.journalId, ...unverifiedSrc }, "PR B: 源刊未核实(conf<70/legacy_unknown), daily-cron 回退命中, 转 needs_review 人工复核"); }
        } catch (e) {
          // 7-28 ②d: 原来这里是 `catch { /* 不阻塞生产 */ }` —— titleBodyBad 保持 null,
          //   于是"三道一致性检查(标题-正文矛盾 / 标题数字编造 / 源刊未核实)一条都没跑成"的文章
          //   直接 generated。这三道恰恰是**信任类**校验, 静默跳过等于把最该拦的那类风险放行。
          //   改法与上面同源: 不判违规(那是冤枉内容), 判"闸没跑成" → needs_review 转人工。
          const msg = e instanceof Error ? e.message : String(e);
          gateUnavailable = gateUnavailable ?? "consistency_check_error";
          logger.warn({ contentId: content.id, err: msg }, "7-28 标题-正文一致性检查异常 → 判「闸没跑成」转 needs_review(异常 ≠ 通过)");
          reportGateIncident(tenantId, content.id, "consistency_check_error", msg);
        }
        // PR-U2(调) 只在质检明确判不通过时转待审; 尊重原质检结论, 不再用分数二次卡(过严会误伤)
        // P0①: 六维质检(重写循环后)仍未过 → 同样转 needs_review, 低分文章人工可在管理端看到, 不阻塞生产
        // 7-28 ②d: gateUnavailable 也算 failed —— "没检查成"必须转待审, 不能默认放行。
        const failed = qPassed === false || sixDimPassedGate === false || titleBodyBad !== null || gateUnavailable !== null;
        if (failed) {
          await transitionStatus(content.id, "generating", "needs_review");
          // 7-03: 区分待审原因 — 标题-正文矛盾 / 评分降级(分数不可信,需重评) / 质量真不过。首过率统计据 sixDimDegraded 排除降级样本。
          // 7-27 换 reason 名: 旧名 sixdim_degraded 让人读成"评了个降级的分"(→ 管理端当劣质内容),
          //   真相是**主+降级模型都没救回来, 这篇根本没评上分**。改叫 quality_check_unavailable,
          //   与"分低"彻底分开; 旧数据的 sixdim_degraded 仍被下游全部判据识别(见 draft-distributor 的 UNSCORED_REASONS)。
          // 7-28 ②d: 原因优先级 —— 查出来的问题(红线/编造) > 没评上分 > 闸没跑成 > 单纯分低。
          //   quality_gate_unavailable **不在** RED_LINE_REASONS 里: 检查器挂了不等于内容有问题,
          //   内容照进草稿箱但排队尾(见 draft-distributor 的 TAIL_REASONS)。
          const reviewMeta = titleBodyBad
            ? { needsReview: true, needsReviewReason: titleBodyBad.reason, titleIssue: titleBodyBad.detail }
            : sixDimDegraded ? { needsReview: true, needsReviewReason: "quality_check_unavailable" }
            : gateUnavailable ? { needsReview: true, needsReviewReason: "quality_gate_unavailable", gateUnavailable }
            : { needsReview: true };
          await db.update(contents)
            .set({ metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify(reviewMeta)}::jsonb` })
            .where(eq(contents.id, content.id));
          await updateRowProgress(rowId, "generated", { articleId: content.id, errorMessage: null });
          logger.info({ rowId, contentId: content.id, qScore, degraded: sixDimDegraded, gateUnavailable },
            sixDimDegraded ? "质检不可用(主+降级模型均失败, 未评上分), 转 needs_review 待重评"
            : gateUnavailable ? `质检闸没跑成(${gateUnavailable}), 转 needs_review 人工复核(≠ 内容有问题)`
            : "PR-U2 质检未过, 转 needs_review 待人工复核");
        } else {
          await transitionStatus(content.id, "generating", "generated");
          await updateRowProgress(rowId, "generated", { articleId: content.id, errorMessage: null });
          logger.info({ rowId, contentId: content.id }, "P4 batch row 生成成功");
        }
        // 7-28 (#5) 修"冷却被误清空": 本行已产出内容(generated 或 needs_review), 把 daily-cron 入队时
        //   写的占位冷却行(contentId NULL)回填 contentId —— 让它脱离下方 catch 分支"删 NULL 占位"的
        //   误伤面, 也让 journal_usage 可按内容溯源。只回填近 2 天窗口(本次占位), 不碰历史 NULL 行
        //   (避免旧占位被错误归因到本篇)。
        if (row.journalId) {
          try {
            await db.update(journalUsage)
              .set({ contentId: content.id })
              .where(and(
                eq(journalUsage.tenantId, tenantId),
                eq(journalUsage.journalId, row.journalId),
                isNull(journalUsage.contentId),
                sql`${journalUsage.usedAt} > NOW() - interval '2 days'`,
              ));
          } catch (e) {
            logger.warn({ rowId, journalId: row.journalId, e }, "#5 journal_usage 回填 contentId 失败(非阻塞)");
          }
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

        // 6-17 #1: 生成彻底失败 → 回滚 daily-cron 入队时写的"占位"冷却(provisional, contentId 为空),
        // 否则这本刊被白锁 JOURNAL_COOLDOWN_DAYS 天却零产出(memory「今日推荐没新内容」根因)。
        // 只删 contentId 为空的占位行; roundup/成功内容写的冷却(带 contentId)不动。
        // 7-28 (#5): 加 2 天时间窗 —— 原来无窗, 一次失败会把该刊**全部历史** NULL 占位行整锅删光,
        //   15 天冷却被清零、该刊次日又可被选(重复推荐的另一主因)。占位行是本批入队时写的,
        //   离最终失败最多小时级(3次退避重试), 2 天窗足够覆盖且伤不到历史冷却;
        //   且成功行现已回填 contentId(见上), 窗口内也删不到它们。
        if (row.journalId) {
          try {
            await db.delete(journalUsage).where(and(
              eq(journalUsage.tenantId, tenantId),
              eq(journalUsage.journalId, row.journalId),
              isNull(journalUsage.contentId),
              sql`${journalUsage.usedAt} > NOW() - interval '2 days'`,
            ));
            logger.info({ rowId, journalId: row.journalId }, "#1 生成失败, 已回滚占位冷却(该刊重新可选)");
          } catch (e) {
            logger.warn({ rowId, journalId: row.journalId, e }, "#1 回滚 journal_usage 失败(非阻塞)");
          }
        }
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
  // PR-Q2: 已是真模板id(含连字符, 如 shunshi-style/data-card) → 直接用, 不走 letter 映射
  if (letter.includes("-")) return letter;
  const map: Record<string, string> = {
    A: "shunshi-style",
    B: "marketing-conversion",
    C: "popular-science",
    E: "industry-vertical",
  };
  return map[letter.toUpperCase()];
}
