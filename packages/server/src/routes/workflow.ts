/**
 * 工作流路由 - 管线式内容生产
 *
 * POST /workflow/generate-article
 *   输入: keywords, title, journals, template
 *   输出: 生成的图文文章（markdown）
 */
import type { FastifyInstance } from "fastify";
import { logger } from "../config/logger.js";
import { getProvider } from "../services/ai/provider-factory.js";
import { db } from "../models/db.js";
import { journals, styleAnalyses, learnedTemplates } from "../models/schema.js";
import { eq, and, ilike, sql, desc } from "drizzle-orm";
import { fetchJournalImages, generateJournalDataCard, svgToDataUri } from "../services/crawler/journal-image-crawler.js";
import { fetchOwnArticles, fetchPeerArticles, analyzeStyle, generateTemplates } from "../services/style-learner.js";

export async function workflowRoutes(app: FastifyInstance) {
  /**
   * 根据工作流上下文生成图文文章
   */
  app.post("/workflow/generate-article", async (request, reply) => {
    const {
      keywords = [],
      title = "",
      journals = [],
      template = "recommend",
      discipline = "",
      track = "domestic",
      stylePrompt = "",
    } = request.body as {
      keywords: string[];
      title: string;
      journals: Array<{ name: string; nameEn?: string; partition?: string; impactFactor?: number; acceptanceRate?: number; reviewCycle?: string }>;
      template: string;
      discipline: string;
      track: string;
      stylePrompt?: string;
    };

    if (!title) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "title 不能为空" });
    }

    const provider = getProvider("cheap");
    if (!provider) {
      return reply.status(503).send({ code: "NO_PROVIDER", message: "没有可用的AI模型" });
    }

    // 构建文章模版提示
    const templatePrompts: Record<string, string> = {
      recommend: `【期刊推荐型】结构：
1. 导语（30字左右，点出读者痛点：想发核心期刊但不知选哪个）
2. 每本推荐期刊用一个小节介绍（期刊名、影响因子、录用率、审稿周期、适合哪类稿件）
3. 投稿建议（100字左右，给出实用的投稿策略）
4. 总结 + 引导（鼓励读者咨询获取更多帮助）`,

      popular: `【热点科普型】结构：
1. 热点引入（用近期学术热点话题切入，30-50字）
2. 专业解读（结合关键词解释学术趋势和研究方向，200-300字）
3. 相关期刊推荐（推荐2-3本适合发表该方向论文的期刊）
4. 投稿指南（审稿周期、录用技巧，100字）
5. 总结 + 引导咨询`,

      compare: `【对比分析型】结构：
1. 背景介绍（为什么要对比这几本期刊，30字）
2. 期刊详细对比表（影响因子、分区、录用率、审稿周期逐项对比）
3. 各刊优劣势分析（每本100字）
4. 推荐方案（根据不同需求给出推荐：追求速度选A，追求影响力选B）
5. 总结 + 引导咨询`,

      guide: `【速发攻略型】结构：
1. 痛点开场（发表周期长、退稿率高等问题，30字）
2. 快速录用期刊推荐（列出3-5本录用率高、审稿快的期刊）
3. 投稿技巧（格式要求、如何提高一次通过率，200字）
4. 时间规划建议（从投稿到见刊的时间线）
5. 结尾引导（欢迎咨询专业代发服务）`,
    };

    const templateGuide = templatePrompts[template] || templatePrompts.recommend;

    // 构建期刊参考信息
    let journalInfo = "";
    if (journals.length > 0) {
      journalInfo = "\n\n【参考期刊数据（请在文中引用）】\n" + journals.map((j, i) =>
        `${i + 1}. ${j.name}${j.nameEn ? ` (${j.nameEn})` : ""} | 分区: ${j.partition || "未知"} | IF: ${j.impactFactor || "N/A"} | 录用率: ${j.acceptanceRate ? (j.acceptanceRate * 100).toFixed(0) + "%" : "N/A"} | 审稿: ${j.reviewCycle || "N/A"}`
      ).join("\n");
    }

    // === 优化1: 生成前注入期刊数据到 prompt，用数据槽位约束 ===
    // 构建严格的数据约束指令
    let dataConstraint = "";
    if (journals.length > 0) {
      dataConstraint = `\n\n【⚠️ 严格数据约束 — 必须逐字使用以下数值，禁止编造或修改】\n`;
      journals.forEach((j, i) => {
        const parts: string[] = [];
        parts.push(`期刊${i + 1}: ${j.name}${j.nameEn ? ` (${j.nameEn})` : ""}`);
        if (j.impactFactor) parts.push(`影响因子(IF) = ${j.impactFactor}`);
        if (j.partition) parts.push(`分区 = ${j.partition}`);
        if (j.acceptanceRate) parts.push(`录用率 = ${(j.acceptanceRate * 100).toFixed(0)}%`);
        if (j.reviewCycle) parts.push(`审稿周期 = ${j.reviewCycle}`);
        dataConstraint += parts.join(" | ") + "\n";
      });
      dataConstraint += `\n当你在文中提到以上任何期刊的数值时，必须与上面完全一致。例如影响因子写 ${journals[0]?.impactFactor || "X.X"}，不能写成其他数字。如果某项数据上面没有提供，文中也不要写该数据。`;
    }

    const prompt = `你是一个专业的学术期刊推荐内容写手，正在为期刊代发服务的公众号写引流文章。

【任务】
根据以下信息生成一篇公众号图文文章。

【文章标题】
${title}

【核心关键词】
${keywords.join("、")}

【学科领域】${discipline || "综合"} | 业务线: ${track === "domestic" ? "国内核心" : "国际SCI"}

【文章模版要求】
${templateGuide}
${dataConstraint}

【写作要求】
1. 文章总字数800-1200字
2. 语气专业但亲切，目标读者是需要发表论文的硕博研究生和青年教师
3. ⚠️ 数据必须严格使用上面【严格数据约束】中提供的数值，一个数字都不能改
4. 如果某项数据没有提供（标注N/A），文中不要提及该数据项
5. 每个小节用 ## 二级标题分隔
6. 文末加一句引导语，如"如需了解更多投稿攻略，欢迎关注/私信咨询"
7. 输出纯Markdown格式，不要加代码块标记
${stylePrompt ? `\n【风格指令（来自AI学习的模版，请严格遵循）】\n${stylePrompt}` : ""}

请直接输出文章内容（以标题开头）：`;

    try {
      logger.info({ title, keywords, template }, "工作流：开始生成文章");

      const result = await provider.chat({
        messages: [{ role: "user", content: prompt }],
        model: "deepseek-chat",
      });

      // === 优化2: 数据槽位填充 — 程序自动修正AI可能写错的数值 ===
      let finalContent = result.content;
      for (const j of journals) {
        if (!j.name) continue;
        // 在提到该期刊名的附近，自动修正数值
        // 构建期刊名匹配模式（中文名或英文名）
        const namePatterns: string[] = [j.name];
        if (j.nameEn) namePatterns.push(j.nameEn);

        for (const nameP of namePatterns) {
          const escaped = nameP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // 修正影响因子：找到期刊名附近（200字以内）的IF数值
          if (j.impactFactor) {
            const ifPattern = new RegExp(
              `(${escaped}[^]*?(?:影响因子|IF|impact factor)[^]*?)(\\d+\\.\\d+)`,
              "gi"
            );
            finalContent = finalContent.replace(ifPattern, (match, prefix, num) => {
              // 只替换距离期刊名200字以内的
              if (prefix.length > 200) return match;
              return prefix + String(j.impactFactor);
            });
          }
        }
      }

      // === 优化: 生成期刊数据卡片 + 抓取封面图 ===
      // Step A: 先生成数据卡片（纯SVG，一定成功）
      const journalImages: Array<{ name: string; coverUrl: string | null; dataCardUri: string }> = journals.map((j) => ({
        name: j.name,
        coverUrl: null,
        dataCardUri: svgToDataUri(generateJournalDataCard(j)),
      }));
      logger.info({ count: journalImages.length }, "工作流：数据卡片SVG已生成");

      // Step B: 尝试从LetPub抓取封面图（失败不影响数据卡片）
      try {
        const imageMap = await fetchJournalImages(journals);
        for (const ji of journalImages) {
          const img = imageMap.get(ji.name);
          if (img?.coverUrl) ji.coverUrl = img.coverUrl;
          if (img?.dataCardUri) ji.dataCardUri = img.dataCardUri;
        }
        logger.info("工作流：LetPub封面图抓取完成");
      } catch (imgErr) {
        logger.warn({ err: imgErr }, "工作流：LetPub封面图抓取失败，使用纯数据卡片");
      }

      // Step C: 在文章中每个期刊首次出现的段落后插入图片
      if (journalImages.length > 0) {
        const lines = finalContent.split("\n");
        const insertedJournals = new Set<string>();
        const newLines: string[] = [];

        // 辅助函数：检查行中是否包含期刊名（支持书名号、空格等变体）
        const lineContainsJournal = (line: string, name: string): boolean => {
          if (line.includes(name)) return true;
          // 去掉书名号后匹配：《教育研究》→ 教育研究
          const stripped = line.replace(/[《》]/g, "");
          if (stripped.includes(name)) return true;
          // 去掉空格后匹配
          const noSpace = line.replace(/\s/g, "");
          if (noSpace.includes(name.replace(/\s/g, ""))) return true;
          return false;
        };

        for (let i = 0; i < lines.length; i++) {
          newLines.push(lines[i]);

          for (const ji of journalImages) {
            if (insertedJournals.has(ji.name)) continue;
            if (!lineContainsJournal(lines[i], ji.name)) continue;

            // 跳过表格分隔行（|:---|）
            if (/^\s*\|[\s:-]+\|/.test(lines[i])) continue;
            // 跳过空行和纯标题行
            if (lines[i].trim() === "" || /^#+\s*$/.test(lines[i].trim())) continue;

            // 如果当前行是表格行，跳到表格结束后再插入
            let insertIdx = i;
            if (lines[i].trim().startsWith("|")) {
              while (insertIdx + 1 < lines.length && lines[insertIdx + 1].trim().startsWith("|")) {
                newLines.push(lines[++insertIdx]);
              }
            }

            // 插入图片
            newLines.push("");
            if (ji.coverUrl) newLines.push(`![${ji.name}封面](${ji.coverUrl})`);
            newLines.push(`![${ji.name}数据卡片](${ji.dataCardUri})`);
            newLines.push("");
            insertedJournals.add(ji.name);

            i = insertIdx;
            break;
          }
        }

        finalContent = newLines.join("\n");
        logger.info({ inserted: insertedJournals.size, total: journalImages.length, names: journalImages.map(j => j.name) }, "工作流：期刊图片注入完成");

        // 如果一个都没插入，强制在文末追加所有数据卡片
        if (insertedJournals.size === 0) {
          logger.warn("工作流：期刊名在文中未找到匹配，强制追加到文末");
          finalContent += "\n\n---\n\n## 推荐期刊数据一览\n\n";
          for (const ji of journalImages) {
            if (ji.coverUrl) finalContent += `![${ji.name}封面](${ji.coverUrl})\n\n`;
            finalContent += `![${ji.name}数据卡片](${ji.dataCardUri})\n\n`;
          }
        }
      }

      logger.info({ title, contentLength: finalContent.length }, "工作流：文章生成完成（含数据槽位修正+图片）");

      return reply.send({
        code: "ok",
        data: {
          content: finalContent,
          title,
          keywords,
          template,
          model: "deepseek-chat",
          journalImages,
        },
      });
    } catch (err) {
      logger.error({ err }, "工作流文章生成失败");
      return reply.status(500).send({
        code: "GENERATE_FAILED",
        message: err instanceof Error ? err.message : "文章生成失败",
      });
    }
  });

  /**
   * 核对文章中的期刊数据准确性
   * 用AI提取文章中提到的期刊名+数据，然后和数据库对比
   */
  app.post("/workflow/verify-article", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const { content, journals: refJournals = [] } = request.body as {
      content: string;
      journals: Array<{ name: string; nameEn?: string; partition?: string; impactFactor?: number; acceptanceRate?: number; reviewCycle?: string }>;
    };

    if (!content) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "content 不能为空" });
    }

    const provider = getProvider("cheap");
    if (!provider) {
      return reply.status(503).send({ code: "NO_PROVIDER", message: "没有可用的AI模型" });
    }

    try {
      logger.info("工作流：开始核对文章准确度");

      // Step 1: AI提取文章中提到的所有期刊名和数据声明
      const extractPrompt = `从以下文章中提取所有提到的期刊信息。
对每本期刊，提取文中声明的：期刊中文名（不含英文）、影响因子(IF)、分区(Q1/Q2/Q3/Q4)、录用率、审稿周期。
注意：name字段只填中文名，不要带括号和英文名。例如文中写"医学前沿（Frontiers in Medicine）"，name只填"医学前沿"。
如果某个字段文中没提到，填null。

输出JSON数组格式（不要加代码块标记），例如：
[{"name":"医学前沿","if":3.9,"partition":"Q2","acceptanceRate":0.45,"reviewCycle":"6-8周"}]

文章内容：
${content}`;

      const extractResult = await provider.chat({
        messages: [{ role: "user", content: extractPrompt }],
        model: "deepseek-chat",
        temperature: 0.1,
      });

      // 解析AI提取结果
      let extractedJournals: Array<{
        name: string;
        if: number | null;
        partition: string | null;
        acceptanceRate: number | null;
        reviewCycle: string | null;
      }> = [];

      try {
        const cleaned = extractResult.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
        extractedJournals = JSON.parse(cleaned);
      } catch {
        logger.warn("AI提取期刊JSON解析失败，使用参考期刊数据");
        // 降级：用传入的参考期刊
        extractedJournals = refJournals.map((j) => ({
          name: j.name,
          if: j.impactFactor || null,
          partition: j.partition || null,
          acceptanceRate: j.acceptanceRate || null,
          reviewCycle: j.reviewCycle || null,
        }));
      }

      // Step 2: 从数据库查找这些期刊的真实数据
      // 先构建参考期刊的快速查找表（来自Step 4选的期刊）
      const refMap = new Map<string, typeof refJournals[0]>();
      for (const rj of refJournals) {
        if (rj.name) refMap.set(rj.name.toLowerCase(), rj);
        if (rj.nameEn) refMap.set(rj.nameEn.toLowerCase(), rj);
      }

      const verifyResults: Array<{
        journalName: string;
        checks: Array<{ field: string; articleValue: string; dbValue: string; match: boolean }>;
        found: boolean;
      }> = [];

      for (const ej of extractedJournals) {
        if (!ej.name) continue;

        // 拆分期刊名：AI可能返回"医学前沿 (Frontiers in Medicine)"这样的格式
        // 需要分别提取中文名和英文名来搜索
        const nameParts: string[] = [];
        const raw = ej.name.trim();

        // 提取括号外的部分（通常是中文名）
        const mainName = raw.replace(/[（(].*?[）)]/g, "").trim();
        if (mainName) nameParts.push(mainName);

        // 提取括号内的部分（通常是英文名）
        const bracketMatch = raw.match(/[（(](.+?)[）)]/);
        if (bracketMatch) nameParts.push(bracketMatch[1].trim());

        // 如果没括号，原名也加上
        if (nameParts.length === 0) nameParts.push(raw);

        // 先从参考期刊表找（最快、最准）
        let refMatch: typeof refJournals[0] | undefined;
        for (const part of nameParts) {
          refMatch = refMap.get(part.toLowerCase());
          if (refMatch) break;
        }

        // 再从数据库模糊查找
        let dbResults: any[] = [];
        for (const part of nameParts) {
          if (part.length < 2) continue;
          dbResults = await db
            .select()
            .from(journals)
            .where(
              and(
                eq(journals.tenantId, tenantId),
                sql`(${ilike(journals.name, `%${part}%`)} OR ${ilike(journals.nameEn, `%${part}%`)})`
              )
            )
            .limit(1);
          if (dbResults.length > 0) break;
        }

        // 如果DB找不到，用参考期刊数据做对比
        if (dbResults.length === 0 && refMatch) {
          // 参考期刊有这个，直接用参考数据对比
          const checks: Array<{ field: string; articleValue: string; dbValue: string; match: boolean }> = [];

          if (ej.if !== null && ej.if !== undefined && refMatch.impactFactor) {
            const diff = Math.abs(ej.if - refMatch.impactFactor);
            checks.push({ field: "影响因子(IF)", articleValue: String(ej.if), dbValue: String(refMatch.impactFactor), match: diff < 0.5 });
          }
          if (ej.partition && refMatch.partition) {
            checks.push({ field: "分区", articleValue: ej.partition, dbValue: refMatch.partition, match: ej.partition.toUpperCase() === refMatch.partition.toUpperCase() });
          }
          if (ej.acceptanceRate !== null && ej.acceptanceRate !== undefined && refMatch.acceptanceRate) {
            const articleRate = ej.acceptanceRate > 1 ? ej.acceptanceRate / 100 : ej.acceptanceRate;
            const diff = Math.abs(articleRate - refMatch.acceptanceRate);
            checks.push({ field: "录用率", articleValue: `${(articleRate * 100).toFixed(0)}%`, dbValue: `${(refMatch.acceptanceRate * 100).toFixed(0)}%`, match: diff < 0.1 });
          }
          if (ej.reviewCycle && refMatch.reviewCycle) {
            checks.push({ field: "审稿周期", articleValue: ej.reviewCycle, dbValue: refMatch.reviewCycle, match: ej.reviewCycle.includes(refMatch.reviewCycle.replace(/周|个月/g, "")) || refMatch.reviewCycle.includes(ej.reviewCycle.replace(/周|个月/g, "")) });
          }

          // 如果没有任何可比字段，至少标记找到了
          if (checks.length === 0) {
            checks.push({ field: "期刊", articleValue: ej.name, dbValue: `${refMatch.name}（参考数据匹配）`, match: true });
          }

          verifyResults.push({
            journalName: `${refMatch.name}${refMatch.nameEn ? ` (${refMatch.nameEn})` : ""}`,
            found: true,
            checks,
          });
          continue;
        }

        if (dbResults.length === 0 && !refMatch) {
          verifyResults.push({
            journalName: ej.name,
            found: false,
            checks: [{ field: "期刊", articleValue: ej.name, dbValue: "数据库中未找到（可能为AI编造）", match: false }],
          });
          continue;
        }

        const dbJ = dbResults[0];
        const checks: Array<{ field: string; articleValue: string; dbValue: string; match: boolean }> = [];

        // 对比影响因子
        if (ej.if !== null && ej.if !== undefined) {
          const dbIF = dbJ.impactFactor || 0;
          const diff = Math.abs(ej.if - dbIF);
          checks.push({
            field: "影响因子(IF)",
            articleValue: String(ej.if),
            dbValue: String(dbIF),
            match: diff < 0.5, // 允许0.5误差
          });
        }

        // 对比分区
        if (ej.partition) {
          checks.push({
            field: "分区",
            articleValue: ej.partition,
            dbValue: dbJ.partition || "未知",
            match: (ej.partition || "").toUpperCase() === (dbJ.partition || "").toUpperCase(),
          });
        }

        // 对比录用率
        if (ej.acceptanceRate !== null && ej.acceptanceRate !== undefined) {
          const dbRate = dbJ.acceptanceRate || 0;
          // 文中可能是百分比(45)或小数(0.45)
          const articleRate = ej.acceptanceRate > 1 ? ej.acceptanceRate / 100 : ej.acceptanceRate;
          const diff = Math.abs(articleRate - dbRate);
          checks.push({
            field: "录用率",
            articleValue: `${(articleRate * 100).toFixed(0)}%`,
            dbValue: dbRate > 0 ? `${(dbRate * 100).toFixed(0)}%` : "N/A",
            match: diff < 0.1, // 允许10%误差
          });
        }

        // 对比审稿周期
        if (ej.reviewCycle) {
          checks.push({
            field: "审稿周期",
            articleValue: ej.reviewCycle,
            dbValue: dbJ.reviewCycle || "N/A",
            match: dbJ.reviewCycle ? ej.reviewCycle.includes(dbJ.reviewCycle.replace(/周|个月/g, "")) || dbJ.reviewCycle.includes(ej.reviewCycle.replace(/周|个月/g, "")) : false,
          });
        }

        // 检查预警
        if (dbJ.isWarningList) {
          checks.push({
            field: "预警状态",
            articleValue: "未提及",
            dbValue: `中科院${dbJ.warningYear || ""}预警名单`,
            match: false,
          });
        }

        verifyResults.push({
          journalName: `${dbJ.name}${dbJ.nameEn ? ` (${dbJ.nameEn})` : ""}`,
          found: true,
          checks,
        });
      }

      // 统计
      const totalChecks = verifyResults.reduce((sum, r) => sum + r.checks.length, 0);
      const passedChecks = verifyResults.reduce((sum, r) => sum + r.checks.filter((c) => c.match).length, 0);
      const accuracy = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

      logger.info({ totalChecks, passedChecks, accuracy }, "工作流：文章核对完成");

      return reply.send({
        code: "ok",
        data: {
          results: verifyResults,
          summary: {
            journalCount: verifyResults.length,
            totalChecks,
            passedChecks,
            failedChecks: totalChecks - passedChecks,
            accuracy,
          },
        },
      });
    } catch (err) {
      logger.error({ err }, "工作流文章核对失败");
      return reply.status(500).send({
        code: "VERIFY_FAILED",
        message: err instanceof Error ? err.message : "核对失败",
      });
    }
  });

  /**
   * 优化3+5: 自动修正 + AI自检链
   * POST /workflow/auto-fix
   *
   * 输入: content（文章内容）, journals（参考期刊数据）, verifyResults（核对结果）
   * 输出: fixedContent（修正后的内容）, fixes（修正明细）, aiReview（AI自检报告）
   */
  app.post("/workflow/auto-fix", async (request, reply) => {
    const {
      content,
      journals: refJournals = [],
      verifyResults = [],
    } = request.body as {
      content: string;
      journals: Array<{ name: string; nameEn?: string; partition?: string; impactFactor?: number; acceptanceRate?: number; reviewCycle?: string }>;
      verifyResults: Array<{
        journalName: string;
        checks: Array<{ field: string; articleValue: string; dbValue: string; match: boolean }>;
      }>;
    };

    if (!content) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "content 不能为空" });
    }

    try {
      let fixedContent = content;
      const fixes: Array<{ field: string; journal: string; from: string; to: string }> = [];

      // Step 1: 程序化精确替换（基于核对结果）
      for (const vr of verifyResults) {
        for (const check of vr.checks) {
          if (check.match) continue; // 正确的不改
          if (check.dbValue === "N/A" || check.dbValue.includes("未找到")) continue;

          const articleVal = check.articleValue;
          const dbVal = check.dbValue;

          // 直接文本替换
          if (articleVal && dbVal && fixedContent.includes(articleVal)) {
            fixedContent = fixedContent.replace(articleVal, dbVal);
            fixes.push({ field: check.field, journal: vr.journalName, from: articleVal, to: dbVal });
          }
        }
      }

      // Step 2: AI自检链 — 第二个AI调用做语义级检查
      let aiReview: { issues: string[]; suggestions: string[]; confidence: number } = {
        issues: [],
        suggestions: [],
        confidence: 100,
      };

      const provider = getProvider("cheap");
      if (provider) {
        // 构建参考数据
        const refData = refJournals.map((j) =>
          `${j.name}: IF=${j.impactFactor || "N/A"}, 分区=${j.partition || "N/A"}, 录用率=${j.acceptanceRate ? (j.acceptanceRate * 100).toFixed(0) + "%" : "N/A"}, 审稿=${j.reviewCycle || "N/A"}`
        ).join("\n");

        const reviewPrompt = `你是一个严格的学术内容审核专家。请对以下文章做全面审查。

【审查重点】
1. 数据准确性：文中的数值是否与参考数据一致
2. 语义合理性：比如"录用率较高"但实际只有5%这种矛盾
3. 逻辑连贯性：上下文是否自洽
4. 学术规范：是否有明显的学术常识错误

【参考数据（真实值）】
${refData}

【文章内容】
${fixedContent}

请输出JSON格式（不要加代码块）：
{"issues":["发现的问题1","问题2"],"suggestions":["修改建议1","建议2"],"confidence":85}

confidence是你对文章准确性的信心分数（0-100）。如果没有问题，issues和suggestions为空数组，confidence为95-100。`;

        try {
          const reviewResult = await provider.chat({
            messages: [{ role: "user", content: reviewPrompt }],
            model: "deepseek-chat",
            temperature: 0.2,
          });

          const cleaned = reviewResult.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
          const parsed = JSON.parse(cleaned);
          aiReview = {
            issues: parsed.issues || [],
            suggestions: parsed.suggestions || [],
            confidence: parsed.confidence || 80,
          };

          // 如果AI发现语义问题，尝试让AI直接修正
          if (aiReview.issues.length > 0 && aiReview.confidence < 80) {
            const fixPrompt = `请修正以下文章中的问题。只修改有问题的部分，保持其他内容不变。

【需要修正的问题】
${aiReview.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

【修正建议】
${aiReview.suggestions.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}

【参考数据（真实值）】
${refData}

【原文】
${fixedContent}

请直接输出修正后的完整文章（纯Markdown格式）：`;

            const fixResult = await provider.chat({
              messages: [{ role: "user", content: fixPrompt }],
              model: "deepseek-chat",
              temperature: 0.3,
            });

            if (fixResult.content && fixResult.content.length > 100) {
              fixedContent = fixResult.content.replace(/```markdown?\s*/g, "").replace(/```/g, "").trim();
              fixes.push({ field: "AI语义修正", journal: "全文", from: "(AI自检发现语义问题)", to: "(已由AI自动修正)" });
            }
          }
        } catch (err) {
          logger.warn({ err }, "AI自检失败，跳过语义审查");
        }
      }

      logger.info({ fixCount: fixes.length, confidence: aiReview.confidence }, "工作流：自动修正完成");

      return reply.send({
        code: "ok",
        data: {
          fixedContent,
          fixes,
          aiReview,
          fixCount: fixes.length,
        },
      });
    } catch (err) {
      logger.error({ err }, "自动修正失败");
      return reply.status(500).send({ code: "FIX_FAILED", message: "自动修正失败" });
    }
  });

  /**
   * 优化4: 多维质量评分
   * POST /workflow/quality-score
   *
   * 输入: content（文章内容）, title, keywords
   * 输出: 可读性/SEO/准确性/原创度的综合评分
   */
  app.post("/workflow/quality-score", async (request, reply) => {
    const { content, title = "", keywords = [] } = request.body as {
      content: string;
      title: string;
      keywords: string[];
    };

    if (!content) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "content 不能为空" });
    }

    try {
      // === 程序化评分（不依赖AI，速度快） ===

      // 1. 可读性评分
      const paragraphs = content.split(/\n\n+/).filter(Boolean);
      const sentences = content.split(/[。！？.!?]+/).filter(Boolean);
      const avgSentenceLen = content.length / Math.max(sentences.length, 1);
      const hasHeadings = /^##\s/m.test(content);
      const headingCount = (content.match(/^##\s/gm) || []).length;

      let readabilityScore = 70;
      if (hasHeadings) readabilityScore += 10;
      if (paragraphs.length >= 4 && paragraphs.length <= 15) readabilityScore += 10;
      if (avgSentenceLen >= 15 && avgSentenceLen <= 50) readabilityScore += 5;
      if (headingCount >= 3 && headingCount <= 8) readabilityScore += 5;
      readabilityScore = Math.min(100, readabilityScore);

      const readabilityDetails = {
        paragraphCount: paragraphs.length,
        sentenceCount: sentences.length,
        avgSentenceLength: Math.round(avgSentenceLen),
        headingCount,
        tips: [] as string[],
      };
      if (!hasHeadings) readabilityDetails.tips.push("建议添加二级标题（##）分隔段落");
      if (avgSentenceLen > 60) readabilityDetails.tips.push("句子偏长，建议控制在30-50字");
      if (paragraphs.length < 3) readabilityDetails.tips.push("段落过少，建议分3-5个段落");

      // 2. SEO评分
      const lowerContent = content.toLowerCase();
      const lowerTitle = title.toLowerCase();
      let seoScore = 60;
      const seoDetails = {
        keywordDensity: {} as Record<string, number>,
        titleContainsKeyword: false,
        contentLength: content.length,
        tips: [] as string[],
      };

      let kwHits = 0;
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        const count = (lowerContent.match(new RegExp(kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        seoDetails.keywordDensity[kw] = count;
        if (count > 0) kwHits++;
        if (lowerTitle.includes(kwLower)) seoDetails.titleContainsKeyword = true;
      }

      if (seoDetails.titleContainsKeyword) seoScore += 15;
      if (kwHits >= keywords.length * 0.7) seoScore += 15;
      if (content.length >= 800 && content.length <= 1500) seoScore += 10;
      else if (content.length >= 600) seoScore += 5;
      seoScore = Math.min(100, seoScore);

      if (!seoDetails.titleContainsKeyword && keywords.length > 0)
        seoDetails.tips.push("标题中未包含核心关键词");
      if (content.length < 600) seoDetails.tips.push("文章偏短，建议至少800字");
      for (const kw of keywords) {
        if ((seoDetails.keywordDensity[kw] || 0) < 2)
          seoDetails.tips.push(`关键词「${kw}」出现次数不足，建议至少出现2-3次`);
      }

      // 3. 内容结构评分
      let structureScore = 70;
      const hasIntro = /^#\s|^##\s.*导|^##\s.*引|^##\s.*前言/m.test(content);
      const hasConclusion = /总结|结语|结论|建议|咨询|关注/m.test(content);
      const hasList = /^[-*]\s|^\d+\.\s/m.test(content);
      const hasEmphasis = /\*\*[^*]+\*\*/m.test(content);

      if (hasIntro) structureScore += 8;
      if (hasConclusion) structureScore += 8;
      if (hasList) structureScore += 7;
      if (hasEmphasis) structureScore += 7;
      structureScore = Math.min(100, structureScore);

      const structureDetails = {
        hasIntro,
        hasConclusion,
        hasList,
        hasEmphasis,
        tips: [] as string[],
      };
      if (!hasConclusion) structureDetails.tips.push("缺少总结或引导语段落");
      if (!hasList) structureDetails.tips.push("建议适当使用列表提升可读性");
      if (!hasEmphasis) structureDetails.tips.push("建议用**加粗**标注关键信息");

      // 4. 综合分
      const overallScore = Math.round(
        readabilityScore * 0.3 + seoScore * 0.35 + structureScore * 0.35
      );

      const publishReady = overallScore >= 75;

      logger.info({ overallScore, readabilityScore, seoScore, structureScore }, "工作流：质量评分完成");

      return reply.send({
        code: "ok",
        data: {
          overall: overallScore,
          publishReady,
          dimensions: {
            readability: { score: readabilityScore, details: readabilityDetails },
            seo: { score: seoScore, details: seoDetails },
            structure: { score: structureScore, details: structureDetails },
          },
          allTips: [
            ...readabilityDetails.tips,
            ...seoDetails.tips,
            ...structureDetails.tips,
          ],
        },
      });
    } catch (err) {
      logger.error({ err }, "质量评分失败");
      return reply.status(500).send({ code: "SCORE_FAILED", message: "评分失败" });
    }
  });

  /**
   * 导出文章为微信公众号排版HTML
   * POST /workflow/export-html
   */
  app.post("/workflow/export-html", async (request, reply) => {
    const { content, title } = request.body as { content: string; title: string };

    if (!content) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "content 不能为空" });
    }

    // 将 markdown 风格的文章转为微信公众号友好的 HTML
    let html = content
      // 标题
      .replace(/^### (.+)$/gm, '<h3 style="font-size:17px;font-weight:bold;color:#333;margin:20px 0 10px;border-left:4px solid #07c160;padding-left:10px;">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="font-size:19px;font-weight:bold;color:#1a1a1a;margin:24px 0 12px;border-bottom:2px solid #07c160;padding-bottom:6px;">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="font-size:22px;font-weight:bold;color:#000;text-align:center;margin:20px 0 16px;">$1</h1>')
      // 加粗
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#07c160;">$1</strong>')
      // 列表
      .replace(/^- (.+)$/gm, '<p style="padding-left:20px;margin:4px 0;line-height:1.8;">• $1</p>')
      .replace(/^\d+\. (.+)$/gm, (match, p1, offset, str) => {
        return `<p style="padding-left:20px;margin:4px 0;line-height:1.8;">${match.split('.')[0]}. ${p1}</p>`;
      })
      // 引用
      .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid #07c160;padding:10px 15px;margin:15px 0;background:#f8f9fa;color:#666;font-size:14px;line-height:1.7;">$1</blockquote>')
      // 图片 ![alt](url) — 支持data:URI中的特殊字符
      .replace(/^!\[([^\]]*)\]\((.+)\)$/gm, '<div style="text-align:center;margin:15px 0;"><img src="$2" alt="$1" style="max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);" /><p style="font-size:12px;color:#999;margin-top:5px;">$1</p></div>')
      // 段落（非HTML行）
      .replace(/^(?!<[h|p|b|s|d])(.+)$/gm, '<p style="font-size:15px;color:#333;line-height:1.9;margin:10px 0;text-indent:2em;">$1</p>');

    // 空行清理
    html = html.replace(/\n{2,}/g, '\n');

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title || "BossMate文章"}</title>
  <style>
    body { max-width: 680px; margin: 0 auto; padding: 20px; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    img { max-width: 100%; }
  </style>
</head>
<body>
${html}
<p style="text-align:center;margin-top:30px;padding-top:15px;border-top:1px solid #eee;font-size:12px;color:#999;">
  由 BossMate AI超级员工 生成
</p>
</body>
</html>`;

    return reply.send({
      code: "ok",
      data: { html: fullHtml },
    });
  });

  // ===== 风格学习相关接口 =====

  /**
   * POST /workflow/learn-style
   * 触发风格学习：抓取自己+同行文章 → AI分析 → 生成模版
   */
  app.post("/workflow/learn-style", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    if (!tenantId) {
      return reply.status(401).send({ code: "NO_TENANT", message: "未找到租户" });
    }

    const {
      learnSelf = true,
      learnPeers = true,
      peerAccounts = [],
      selfCount = 20,
      peerMaxPerAccount = 5,
    } = request.body as {
      learnSelf?: boolean;
      learnPeers?: boolean;
      peerAccounts?: string[];
      selfCount?: number;
      peerMaxPerAccount?: number;
    };

    try {
      const allAnalyses: any[] = [];
      const progress: string[] = [];

      // 1. 抓取自己的文章
      if (learnSelf) {
        progress.push("正在获取公众号历史文章...");
        try {
          const ownArticles = await fetchOwnArticles(tenantId, selfCount);
          progress.push(`获取到 ${ownArticles.length} 篇自己的文章`);

          if (ownArticles.length > 0) {
            progress.push("正在分析自己的文章风格...");
            const selfAnalysis = await analyzeStyle(ownArticles, "我的公众号", "self");
            if (selfAnalysis) {
              allAnalyses.push(selfAnalysis);
              // 保存到数据库
              await db.insert(styleAnalyses).values({
                tenantId,
                accountName: selfAnalysis.accountName,
                source: "self",
                articleCount: selfAnalysis.articleCount,
                titlePatterns: selfAnalysis.titlePatterns,
                contentStyle: selfAnalysis.contentStyle,
                layoutFeatures: selfAnalysis.layoutFeatures,
                overallSummary: selfAnalysis.overallSummary,
              });
              progress.push("自己的风格分析完成");
            }
          }
        } catch (err) {
          progress.push(`自己文章抓取失败: ${String(err)}`);
          logger.warn({ err }, "自己文章抓取失败");
        }
      }

      // 2. 抓取同行文章
      if (learnPeers) {
        progress.push("正在搜索同行公众号文章...");
        try {
          const peerArticles = await fetchPeerArticles(
            peerAccounts.length > 0 ? peerAccounts : undefined,
            peerMaxPerAccount
          );
          progress.push(`获取到 ${peerArticles.length} 篇同行文章`);

          // 按账号分组分析
          const byAccount = new Map<string, typeof peerArticles>();
          for (const a of peerArticles) {
            const name = a.accountName || "unknown";
            if (!byAccount.has(name)) byAccount.set(name, []);
            byAccount.get(name)!.push(a);
          }

          for (const [accountName, articles] of byAccount) {
            progress.push(`正在分析「${accountName}」的风格...`);
            const peerAnalysis = await analyzeStyle(articles, accountName, "peer");
            if (peerAnalysis) {
              allAnalyses.push(peerAnalysis);
              await db.insert(styleAnalyses).values({
                tenantId,
                accountName: peerAnalysis.accountName,
                source: "peer",
                articleCount: peerAnalysis.articleCount,
                titlePatterns: peerAnalysis.titlePatterns,
                contentStyle: peerAnalysis.contentStyle,
                layoutFeatures: peerAnalysis.layoutFeatures,
                overallSummary: peerAnalysis.overallSummary,
              });
            }
          }
          progress.push(`同行风格分析完成（${byAccount.size} 个账号）`);
        } catch (err) {
          progress.push(`同行文章抓取失败: ${String(err)}`);
          logger.warn({ err }, "同行文章抓取失败");
        }
      }

      // 3. 生成模版库
      let generatedTpls: any[] = [];
      if (allAnalyses.length > 0) {
        progress.push("正在根据风格分析生成模版库...");
        generatedTpls = await generateTemplates(allAnalyses);

        // 保存到数据库
        for (const tpl of generatedTpls) {
          await db.insert(learnedTemplates).values({
            tenantId,
            name: tpl.name,
            desc: tpl.desc,
            icon: tpl.icon,
            source: tpl.source,
            sourceAccount: tpl.sourceAccount,
            sections: tpl.sections,
            titleFormula: tpl.titleFormula,
            styleTags: tpl.styleTags,
            sampleTitle: tpl.sampleTitle,
            prompt: tpl.prompt,
          });
        }
        progress.push(`成功生成 ${generatedTpls.length} 个文章模版`);
      }

      return reply.send({
        code: "ok",
        data: {
          analyses: allAnalyses,
          templates: generatedTpls,
          progress,
        },
      });
    } catch (err) {
      logger.error({ err }, "风格学习失败");
      return reply.status(500).send({ code: "ERROR", message: String(err) });
    }
  });

  /**
   * GET /workflow/style-analyses
   * 获取已保存的风格分析结果
   */
  app.get("/workflow/style-analyses", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    if (!tenantId) {
      return reply.status(401).send({ code: "NO_TENANT", message: "未找到租户" });
    }

    const results = await db
      .select()
      .from(styleAnalyses)
      .where(eq(styleAnalyses.tenantId, tenantId))
      .orderBy(desc(styleAnalyses.createdAt));

    return reply.send({ code: "ok", data: results });
  });

  /**
   * GET /workflow/learned-templates
   * 获取已学习生成的模版库
   */
  app.get("/workflow/learned-templates", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    if (!tenantId) {
      return reply.status(401).send({ code: "NO_TENANT", message: "未找到租户" });
    }

    const results = await db
      .select()
      .from(learnedTemplates)
      .where(
        and(
          eq(learnedTemplates.tenantId, tenantId),
          eq(learnedTemplates.isActive, true)
        )
      )
      .orderBy(desc(learnedTemplates.createdAt));

    return reply.send({ code: "ok", data: results });
  });

  /**
   * DELETE /workflow/learned-templates/:id
   * 停用一个学习模版
   */
  app.delete("/workflow/learned-templates/:id", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const { id } = request.params as { id: string };

    await db
      .update(learnedTemplates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(learnedTemplates.id, id), eq(learnedTemplates.tenantId, tenantId))
      );

    return reply.send({ code: "ok" });
  });

  /**
   * DELETE /workflow/style-analyses
   * 清空风格分析和学习模版（重新学习前）
   */
  app.delete("/workflow/style-analyses", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    if (!tenantId) {
      return reply.status(401).send({ code: "NO_TENANT", message: "未找到租户" });
    }

    await db.delete(styleAnalyses).where(eq(styleAnalyses.tenantId, tenantId));
    await db.delete(learnedTemplates).where(eq(learnedTemplates.tenantId, tenantId));

    return reply.send({ code: "ok" });
  });
}
