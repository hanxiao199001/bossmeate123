/**
 * P0四件套编排器：生成全文之后、入库之前的质量流水线（独立模块，多条生成路径共用）
 *
 *   ④压缩去水分 → ③AI腔检测+段落级清洗 → ①老韩六维质检 → 未过→定向重写循环（重写段落再过③）
 *
 * 接线方（都调 runArticleQualityPasses）：
 *   - services/batch/batch-worker.ts     —— 批量生产主路径（daily-cron domestic/international → createBatch → 这里）
 *   - services/content-engine/article-pipeline.ts —— runArticlePipeline 路由路径
 *   - services/recommendation/daily-cron.ts topicPool —— generateByFormat 路径
 *   - scripts/sample-article.ts          —— 验收样片（打印六维明细）
 *
 * 铁律：任何 pass 的 LLM 失败 → 用当前文本继续/跳过该 pass，绝不 throw、绝不阻塞生成。
 * 成本封顶：正常路径 ≤3 次新增 LLM 调用；重写循环每轮 ≤4 次、最多 ARTICLE_QUALITY_REWRITE_MAX（默认2）轮。
 */
import { eq } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { chat } from "../ai/chat-service.js";
import { condenseArticle } from "./condense.js";
import {
  detectCliches,
  removeCliches,
  extractProseSegments,
  replaceSegments,
  looksLikeHtml,
} from "./decliche.js";
import {
  sixDimQualityCheck,
  SIX_DIM_LABELS,
  type SixDimKey,
  type SixDimResult,
} from "./quality-check-v2.js";
import { splitByH2, rewriteSectionInBody, spliceSection } from "./section-rewrite.js";
import { applyImageSlots, applyImageSlotsFallback, fixDoubleEscapedEntities } from "./image-slots.js";
import { SIX_DIM_SCORING_VERSION } from "./quality-thresholds.js";

// ============ 类型 ============

export interface QualityLoopMeta {
  /** 实际跑了几轮定向重写 */
  rounds: number;
  /** 最终六维分（key→0-10） */
  finalScores: Record<string, number> | null;
  finalTotal: number | null;
  passed: boolean | null;
  /** 循环未生效的原因（disabled/degraded/no_sections 等） */
  skippedReason?: string;
}

export interface QualityPipelineResult {
  body: string;
  /** body 是否被任何 pass 改过 */
  changed: boolean;
  condense: { applied: boolean; reason?: string; ratio?: number };
  decliche: { hits: number; rewritten: boolean };
  sixDim: SixDimResult | null;
  qualityLoop: QualityLoopMeta;
  /** 本次流水线实际发出的 LLM 调用数（成本审计用） */
  llmCalls: number;
}

/**
 * 7-03 B-②: 期刊硬数据 → 定向重写用的紧凑清单字符串。字段容错(不同调用方 journal 形状不同)。
 * 刻意不含自引率(selfCitationRate): 选B, OpenAlex 派生不可靠, 标题正文都不用。
 */
export function buildJournalDataContext(j: Record<string, any> | null | undefined): string | undefined {
  if (!j) return undefined;
  const L: string[] = [];
  const name = j.name || j.nameEn;
  if (name) L.push(`期刊：${name}${j.nameEn && j.nameEn !== name ? `（${j.nameEn}）` : ""}`);
  if (j.impactFactor != null) L.push(`影响因子：${j.impactFactor}`);
  if (j.casPartition || j.partition) L.push(`中科院分区：${j.casPartition || j.partition}`);
  if (j.casPartitionNew) L.push(`新锐分区：${j.casPartitionNew}`);
  if (j.acceptanceRate != null) L.push(`录用率：${(j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100).toFixed(0)}%`);
  else if (j.acceptanceDifficulty) L.push(`投稿难度：${j.acceptanceDifficulty}`);
  if (j.reviewCycle) L.push(`审稿周期：${j.reviewCycle}`);
  const apc = j.apcFee ?? j.publicationCosts?.apc ?? null;
  if (apc === 0) L.push(`版面费：免费(无APC)`);
  else if (apc != null && apc > 0) L.push(`版面费(APC)：${j.publicationCosts?.currency || "USD"} ${apc}`);
  if (j.annualVolume) L.push(`年发文量：约${j.annualVolume}篇/年`);
  if (j.isWarningList) L.push("⚠️在中科院预警名单中");
  if (j.publisher) L.push(`出版商：${j.publisher}`);
  return L.length ? L.map((s) => `- ${s}`).join("\n") : undefined;
}

// ============ 主入口 ============

export async function runArticleQualityPasses(params: {
  tenantId: string;
  userId?: string;
  title: string;
  body: string;
  journalId?: string; // 7-03 B-②: 传 journalId, 内部查库构造硬数据清单, 透传给定向重写(数据准确/密度维度补数)
  contentId?: string; // 7-27: 透传给质检告警(ops_incidents.detail.contentId), 简报能点开是哪几篇
}): Promise<QualityPipelineResult> {
  const { tenantId, userId, title, journalId, contentId } = params;

  /**
   * 心跳（8-18）。**纯观测**：写失败绝不中断生成，内部 catch 掉只记日志 ——
   * 观测手段不许有业务影响力（与"旁路告警绝不搞挂主流程"同源）。
   *
   * 打在**有外部可验证进展**的点之后（LLM 返回、章节写完、质检出分），
   * 不打在循环入口或纯 CPU 步骤前后 —— 那些不证明活干到哪了。
   * 点位与点间最坏耗时见 `services/articles/watchdog.ts` 文件头那张表。
   */
  const beat = async (point: string) => {
    if (!contentId) return;
    const { touchGenerationHeartbeat } = await import("../articles/watchdog.js");
    await touchGenerationHeartbeat(contentId, point);
  };
  let body = params.body || "";
  const originalBody = body;
  let llmCalls = 0;

  // 7-03 B-②: 查期刊真实硬数据 → 定向重写补数上下文(查不到/无id 就不带, 退回原行为)
  let journalContext: string | undefined;
  let journalFacts: import("../compliance/content-check.js").TitleDataDbFields | undefined;
  let journalRow: Record<string, unknown> | undefined; // 7-03 ②: 图位替换要用完整 row（jsonb 图表字段 + 封面）
  if (journalId) {
    try {
      const [jr] = await db.select().from(journals).where(eq(journals.id, journalId)).limit(1);
      journalRow = jr as Record<string, unknown> | undefined;
      journalContext = buildJournalDataContext(journalRow);
      // 7-20 反"奖励编造": 抽该刊 DB 事实喂给六维评分器, 正文无据 IF/分区 → dataAccuracy 压红线分
      const jf = journalRow as Record<string, any>;
      journalFacts = {
        reviewCycle: jf.reviewCycle ?? null, acceptanceRate: jf.acceptanceRate ?? null,
        impactFactor: jf.impactFactor ?? null, compositeImpactFactor: jf.compositeImpactFactor ?? null,
        partition: jf.partition ?? null, casPartition: jf.casPartition ?? null,
        casPartitionNew: jf.casPartitionNew ?? null, jcrFull: jf.jcrFull ?? null,
      };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, journalId }, "B-② 期刊数据查询失败, 重写不带硬数据");
    }
  }

  // ---- ④ 压缩去水分（env ARTICLE_CONDENSE，内部自带短文/模板HTML/比例护栏） ----
  let condenseMeta: QualityPipelineResult["condense"] = { applied: false, reason: "skipped" };
  try {
    const c = await condenseArticle(body, {
      tenantId,
      userId,
      targetRatio: env.ARTICLE_CONDENSE_RATIO,
    });
    body = c.body;
    llmCalls += c.llmCalls;
    await beat("D_condense");   // 压缩产物落定 = 有进展
    condenseMeta = { applied: c.applied, reason: c.reason, ratio: c.ratio };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "P0④ condense pass 异常，跳过");
  }

  // ---- ③ AI 腔检测 + 段落级清洗（env ARTICLE_DECLICHE） ----
  let declicheMeta: QualityPipelineResult["decliche"] = { hits: 0, rewritten: false };
  if (env.ARTICLE_DECLICHE !== "false") {
    try {
      const d = await removeCliches(body, { tenantId, userId });
      body = d.text;
      llmCalls += d.llmCalls;
      declicheMeta = { hits: d.hits.length, rewritten: d.rewritten };
      await beat("E_decliche");   // 去 AI 腔产物落定
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "P0③ decliche pass 异常，跳过");
    }
  }

  // ---- ② 图位标记替换 + 双重转义修复（7-03 图文交替; 压缩/禁词之后、六维质检之前）----
  // 幂等: article-skill 已替换过的签名不重复出图; 没数据/编造的 {{IMG:xxx}} 标记删除, 绝不泄漏字面。
  try {
    const slot = applyImageSlots(body, journalRow ?? null);
    if (slot.changed) {
      body = slot.body;
      logger.info({ inserted: slot.inserted, droppedMarkers: slot.dropped.length }, "7-03 图位标记替换(pipeline 兜底)完成");
    }
    // 7-03 B: 确定性保底 — 只对无内建图表的路径(markdown/非图表模板)。shunshi 等已有 <svg>/<img> → 门内跳过, 不重复出图。
    const fb = applyImageSlotsFallback(body, journalRow ?? null);
    if (fb.changed) {
      body = fb.body;
      logger.info({ inserted: fb.inserted }, "7-03 图位确定性保底(无内建图路径, 规则位插入)");
    }
    const fixed = fixDoubleEscapedEntities(body);
    if (fixed !== body) {
      logger.info("7-03 修复双重转义泄漏(&amp;lt; 等)");
      body = fixed;
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "7-03 图位/转义后处理异常, 跳过");
  }

  // ---- ① 六维质检 + 定向重写闭环（env ARTICLE_SIXDIM_QC） ----
  let sixDim: SixDimResult | null = null;
  const loop: QualityLoopMeta = { rounds: 0, finalScores: null, finalTotal: null, passed: null };

  if (env.ARTICLE_SIXDIM_QC === "false") {
    loop.skippedReason = "disabled";
  } else {
    sixDim = await sixDimQualityCheck({ tenantId, title, body, journalFacts, ...(contentId ? { contentId } : {}) });
    llmCalls += 1;
    await beat("F_sixdim");   // 拿到分数 = 最坏的一段(12 分)刚过去

    const maxRounds = Math.max(0, env.ARTICLE_QUALITY_REWRITE_MAX);
    if (sixDim.degraded) {
      // 评分服务本身降级 → 分数不可信，重写只会瞎改，直接跳过循环
      loop.skippedReason = "degraded";
    } else {
      while (!sixDim.passed && loop.rounds < maxRounds) {
        const roundNo = loop.rounds + 1;
        try {
          const { newBody, rewrote, calls } = await targetedRewriteRound({
            tenantId,
            userId,
            body,
            sixDim,
            roundNo,
            journalContext,
          });
          llmCalls += calls;
          if (!rewrote) {
            // 重写落不了地（无章节可定位/LLM 全挂）→ 按现状收尾，别空转烧钱
            loop.skippedReason = loop.skippedReason ?? "rewrite_not_applicable";
            break;
          }
          body = newBody;
          // 重新六维质检（重写后的效果要用同一把尺子验证）
          sixDim = await sixDimQualityCheck({ tenantId, title, body, journalFacts, ...(contentId ? { contentId } : {}) });
          llmCalls += 1;
          await beat(`G_rewrite_round${loop.rounds}`);   // 每轮重写 + 复评之后
          loop.rounds = roundNo;
          if (sixDim.degraded) break;
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err, round: roundNo }, "P0① 重写循环异常，按现状收尾");
          break;
        }
      }
    }

    // 7-27「0 分 vs 没评上分」: 降级时六维返回的全 0 只是类型占位, 语义是**没评上分**。
    //   原来照抄进 metadata.sixDimTotal=0, 于是管理端/排序/统计一律把它当"极差内容"看,
    //   而真相是"评分器当时超时了, 这篇根本没被评"。降级时一律写 null(= 未评分), 由
    //   sixDimDegraded / sixDimDegradedReason 说明为什么。非降级路径行为完全不变。
    if (sixDim.degraded) {
      loop.finalScores = null;
      loop.finalTotal = null;
    } else {
      loop.finalScores = Object.fromEntries(
        (Object.keys(sixDim.dims) as SixDimKey[]).map((k) => [k, sixDim!.dims[k].score])
      );
      loop.finalTotal = sixDim.totalScore;
    }
    loop.passed = sixDim.passed;
  }

  const result: QualityPipelineResult = {
    body,
    changed: body !== originalBody,
    condense: condenseMeta,
    decliche: declicheMeta,
    sixDim,
    qualityLoop: loop,
    llmCalls,
  };

  logger.info(
    {
      condensed: condenseMeta.applied,
      clicheHits: declicheMeta.hits,
      sixDimTotal: sixDim?.totalScore ?? null,
      sixDimPassed: sixDim?.passed ?? null,
      rewriteRounds: loop.rounds,
      llmCalls,
    },
    "P0四件套流水线完成"
  );
  return result;
}

// ============ 定向重写（单轮） ============

/**
 * 取分数最低的 ≤2 个维度，对其 weakestSection 做定向重写：
 * - markdown（有 `## ` 章节）：复用 section-rewrite 的 rewriteSectionInBody，逐节精修
 * - 模板 HTML（无 `## `）：把正文段落（<p>/<li>）打包一次 LLM 调用做"问题定向修改"，
 *   数据卡/图表/样式块物理隔离不送 LLM，排版不可能被改坏
 * 重写后的文本再过一遍 ③ 禁词清洗（detect 免费，有命中才多 1 次调用）。
 */
async function targetedRewriteRound(params: {
  tenantId: string;
  userId?: string;
  body: string;
  sixDim: SixDimResult;
  roundNo: number;
  journalContext?: string;
}): Promise<{ newBody: string; rewrote: boolean; calls: number }> {
  const { tenantId, userId, sixDim, roundNo, journalContext } = params;
  let body = params.body;
  let calls = 0;
  let rewrote = false;

  // 分数最低的 ≤2 个未达标维度
  const lowDims = (Object.keys(sixDim.dims) as SixDimKey[])
    .filter((k) => sixDim.dims[k].score < 8)
    .sort((a, b) => sixDim.dims[a].score - sixDim.dims[b].score)
    .slice(0, 2);
  if (lowDims.length === 0) return { newBody: body, rewrote: false, calls: 0 };

  const isMarkdownSections = !looksLikeHtml(body) && splitByH2(body).length > 0;

  if (isMarkdownSections) {
    // markdown：逐维度定向重写其 weakestSection（复用老板精修同款逻辑）
    const rewrittenSections = new Set<string>();
    for (const k of lowDims) {
      const d = sixDim.dims[k];
      const sectionKey = d.weakestSection || "全文";
      if (rewrittenSections.has(sectionKey)) continue; // 两个维度指向同一节时只重写一次
      const instruction = `【${SIX_DIM_LABELS[k]}】维度只得 ${d.score}/10 分。修改要求：${d.fixHint || "提升该维度质量"}。信息与数据保持真实，不得编造。`;
      try {
        const core = await rewriteSectionInBody({
          body,
          sectionHeading: sectionKey,
          instruction,
          journalContext,
        });
        calls += 1;
        if (core.rewrittenBody) {
          body = spliceSection(body, core.target, core.rewrittenHeading, core.rewrittenBody);
          rewrittenSections.add(sectionKey);
          rewrote = true;
          logger.info({ round: roundNo, dim: k, section: core.target.headingText }, "P0① 定向重写章节完成");
        }
      } catch (err) {
        // 单节失败不影响其它维度的重写（section_not_found / LLM 挂 都只跳过）
        logger.warn(
          { err: err instanceof Error ? err.message : err, dim: k, section: sectionKey },
          "P0① 单节定向重写失败，跳过该维度"
        );
        // rewriteSectionInBody 在 LLM 调用前抛错（无章节等）时没花钱；调用后抛错已花钱，统一按 1 计保守估算
        if (!(err instanceof Error && (err.message === "no_h2_sections" || err.message === "section_not_found" || err.message === "no_ai_provider"))) {
          calls += 1;
        }
      }
    }
  } else {
    // 模板 HTML：无 `## ` 章节可定位 → 段落打包定向修改（单次调用）
    const r = await htmlProseTargetedRewrite({ tenantId, userId, body, sixDim, lowDims, journalContext });
    calls += r.calls;
    if (r.rewrote) {
      body = r.newBody;
      rewrote = true;
    }
  }

  // 重写后的段落也过 ③：detect 是纯函数零成本，有命中才发 1 次清洗调用
  if (rewrote && env.ARTICLE_DECLICHE !== "false" && detectCliches(body).length > 0) {
    try {
      const d = await removeCliches(body, { tenantId, userId });
      body = d.text;
      calls += d.llmCalls;
    } catch { /* 清洗失败保留重写结果 */ }
  }

  return { newBody: body, rewrote, calls };
}

/**
 * 模板 HTML 文章的定向修改：只送 <p>/<li>/<h3>/<h4> 正文段（≤8000字），
 * 让 LLM 按 fixHint 只改有问题的段并按编号返回，其余段原样保留。
 */
async function htmlProseTargetedRewrite(params: {
  tenantId: string;
  userId?: string;
  body: string;
  sixDim: SixDimResult;
  lowDims: SixDimKey[];
  journalContext?: string;
}): Promise<{ newBody: string; rewrote: boolean; calls: number }> {
  const { tenantId, userId, body, sixDim, lowDims, journalContext } = params;

  const segments = extractProseSegments(body);
  if (segments.length === 0) return { newBody: body, rewrote: false, calls: 0 };

  // 成本护栏：正文段累计 ≤8000 字符（模板文数据卡不在其列，正常都装得下）
  const capped: typeof segments = [];
  let budget = 8000;
  for (const s of segments) {
    if (s.text.length > budget) break;
    capped.push(s);
    budget -= s.text.length;
  }
  if (capped.length === 0) return { newBody: body, rewrote: false, calls: 0 };

  const problems = lowDims
    .map((k) => `- 【${SIX_DIM_LABELS[k]}】${sixDim.dims[k].score}/10 分，薄弱位置：${sixDim.dims[k].weakestSection}。修法：${sixDim.dims[k].fixHint}`)
    .join("\n");
  const numbered = capped.map((s, i) => `【段${i + 1}】${s.text}`).join("\n");

  try {
    const resp = await chat({
      tenantId,
      userId: userId || "system",
      conversationId: `qloop-html-${Date.now()}`,
      skillType: "content_generation",
      message: `这是一篇公众号文章的正文段落（HTML 片段，按编号列出）。质检发现以下问题：
${problems}
${journalContext ? `\n【期刊真实硬数据（补数据/提密度只能用这里的，严禁编造/改数）】\n${journalContext}\n` : ""}
请定向修改：
1. 只改与上述问题相关的段落，其余段落**不要**出现在输出里
2. 保留每段的 HTML 标签结构（<p>/<li>/<strong> 等）原样，只改文字
2b. 保持短段落节奏：每段最多 3 句 / ≤100 字，绝不把多段合并成长段（图文交替排版靠短段落，改后段落不能变长块）
3. 数据/事实以原文和上面【期刊真实硬数据】为准；补硬数据只能用清单里的真实数字，严禁编造或改数；缺的字段写"暂无数据"或不提，严禁推断"未被WOS/SCIE收录"/"未标注"/"可能不是SCI"制造自相矛盾（有中科院分区即说明被收录）
4. 只输出 JSON（改了哪段就给哪段）：{"3":"改后的段3","7":"改后的段7"}，不要解释

${numbered}`,
    });

    const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { newBody: body, rewrote: false, calls: 1 };
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;

    const replacements: Array<{ seg: (typeof capped)[number]; newText: string }> = [];
    for (const [k, v] of Object.entries(parsed)) {
      const idx = Number(k) - 1;
      const seg = capped[idx];
      // 校验：段存在 + 非空 + 长度 40%-250%（防吞段/注水/改崩标签）
      if (seg && typeof v === "string" && v.trim().length >= seg.text.length * 0.4 && v.length <= seg.text.length * 2.5) {
        replacements.push({ seg, newText: v.trim() });
      }
    }
    if (replacements.length === 0) return { newBody: body, rewrote: false, calls: 1 };

    const newBody = replaceSegments(body, replacements);
    logger.info({ segsChanged: replacements.length, dims: lowDims }, "P0① HTML 段落级定向重写完成");
    return { newBody, rewrote: true, calls: 1 };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "P0① HTML 定向重写失败，保留原文");
    return { newBody: body, rewrote: false, calls: 1 };
  }
}

/**
 * 给 contents.metadata 用的精简元数据（各接线方统一格式，管理端好读）。
 */
export function qualityPipelineMeta(qp: QualityPipelineResult): Record<string, unknown> {
  return {
    sixDimScores: qp.qualityLoop.finalScores,
    sixDimTotal: qp.qualityLoop.finalTotal,
    sixDimPassed: qp.qualityLoop.passed,
    /**
     * 🔴 8-21: 打这个分用的**标尺版本**。规矩见 quality-thresholds.ts 的
     * SIX_DIM_SCORING_VERSION 文件注释 —— 改评分 prompt 必须同时 +1。
     *
     * 没有它的话，8-21 之后的判据改动会让新旧分静默混在同一列里：
     * 「本周达标率比上周高」在跨版本时是一句无意义的话，而它看起来完全正常。
     * 存量行没有此字段 = v2 之前，统计时按 legacy 单独归类，别并进任何一版。
     */
    sixDimScoringVersion: SIX_DIM_SCORING_VERSION,
    sixDimDegraded: qp.sixDim?.degraded ?? null,
    // 7-27: 降级原因(AI 超时/无响应 vs 输出解析失败)。sixDimTotal 此时是 null(未评分, 非 0 分)。
    ...(qp.sixDim?.degraded ? { sixDimDegradedReason: qp.sixDim.degradedReason ?? "评分服务降级" } : {}),
    // 7-27 分数的**出处**: primary=主评分模型(与历史分同尺) / fallback=主模型不可用时自动换的快模型。
    //   落库是为了日后能把降级分单独捞出来抽检可信度 —— 降级分不该混进标定样本(calibration-sample)
    //   和"首过率"的历史对比里, 否则以后分数波动会归因不了。
    ...(qp.sixDim && !qp.sixDim.degraded
      ? { sixDimScoredBy: qp.sixDim.scoredBy ?? "primary", sixDimScorerModel: qp.sixDim.scorerModel ?? null }
      : {}),
    // 7-05 ①: 存失败维度(score<8)的 weakestSection + fixHint, 供待审卡片露出"哪挂了/怎么改"
    sixDimWeak: qp.sixDim && !qp.sixDim.degraded
      ? (Object.keys(qp.sixDim.dims) as SixDimKey[])
          .filter((k) => qp.sixDim!.dims[k].score < 8)
          .map((k) => ({ dim: k, label: SIX_DIM_LABELS[k], score: qp.sixDim!.dims[k].score, weakest: qp.sixDim!.dims[k].weakestSection, fixHint: qp.sixDim!.dims[k].fixHint }))
      : [],
    dataDensity: qp.sixDim?.dataDensity,
    qualityLoop: { rounds: qp.qualityLoop.rounds, finalScores: qp.qualityLoop.finalScores, ...(qp.qualityLoop.skippedReason ? { skippedReason: qp.qualityLoop.skippedReason } : {}) },
    condensed: qp.condense.applied,
    ...(qp.condense.ratio ? { condenseRatio: Number(qp.condense.ratio.toFixed(2)) } : {}),
    clicheHits: qp.decliche.hits,
    clicheRewritten: qp.decliche.rewritten,
    qualityPipelineLlmCalls: qp.llmCalls,
  };
}
