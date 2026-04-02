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
import { fetchJournalCoverMultiSource, generateJournalDataCard, svgToDataUri } from "../services/crawler/journal-image-crawler.js";
import { fetchOwnArticles, fetchPeerArticles, analyzeStyle, generateTemplates } from "../services/style-learner.js";
import { retrieveForWorkflow } from "../services/knowledge/rag-retriever.js";

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

    // ============ 专业文章结构模版（v2 深度优化） ============
    // 每种模版定义：结构蓝图 + 各章节字数 + 写作范式 + SEO指令
    const templatePrompts: Record<string, string> = {
      recommend: `【期刊推荐型 · 结构蓝图】

你必须严格按照以下6个章节依次输出，每个章节用 ## 二级标题，标题文字按要求写：

## 一、为什么选对期刊比写好论文更重要？
（120-150字。以读者视角切入，描述"投稿迷茫"的常见困境：不知道选什么刊、害怕拒稿浪费时间、不了解分区规则。用1-2个具体场景引起共鸣，如"花了3个月等审稿结果，最终被拒"。）

## 二、${keywords[0] || "本领域"}方向，这几本期刊值得重点关注
（主体部分，每本期刊150-200字。每本期刊按以下格式介绍：
  **期刊名 · 一句话定位**
  - 📊 核心数据：影响因子、分区、录用率、审稿周期（必须用【严格数据约束】中的数值）
  - 🎯 适合人群：什么方向、什么阶段的作者适合投这本
  - 💡 投稿贴士：该刊偏好的研究类型或写作风格
段落之间空一行，增加可读性。）

## 三、投稿策略：如何提高一次命中率？
（200-250字。给出3-4条实操建议，如：先读目标刊最近3期的热点主题、注意格式规范、善用Cover Letter突出创新点、考虑"梯度投稿"策略。每条建议用 **加粗关键词** 开头。）

## 四、常见误区提醒
（100-120字。列出2-3个投稿新手常犯的错误，如"只看影响因子不看匹配度""忽视审稿周期导致毕业延期"。用 > 引用块格式突出。）

## 五、总结与行动建议
（80-100字。简要回顾推荐思路，给出"下一步该做什么"的清晰指引。）

## 六、需要更多投稿指导？
（30-50字。引导关注/咨询，语气温和专业，不要过于营销化。例如："如需针对您的研究方向做个性化期刊匹配，欢迎留言或私信，我们为您一对一分析。"）`,

      popular: `【热点科普型 · 结构蓝图】

你必须严格按照以下6个章节依次输出，每个章节用 ## 二级标题，标题文字按要求写：

## 一、${keywords[0] || "这个学术热点"}，为什么最近这么火？
（120-150字。用近期学术界或政策层面的真实变化切入，解释这个方向为什么突然受关注。可以引用"据XX数据库统计""2024年以来""最新政策要求"等话术增加可信度。避免空泛表述。）

## 二、深度解读：${keywords[0] || "该方向"}的研究前沿与趋势
（300-350字。这是文章主体。分2-3个小角度解读：
  **角度一：核心研究问题**（当前学者主要在解决什么问题）
  **角度二：方法论演进**（从传统方法到新兴技术的变化）
  **角度三：跨学科融合**（与哪些领域产生交叉，如AI+医学）
每个角度用 **加粗标题** 引导，内容紧扣关键词，体现专业深度。）

## 三、想在这个方向发论文？推荐这几本期刊
（每本期刊100-150字。说明为什么这本刊适合发表该方向论文：
  - 📊 期刊数据（用【严格数据约束】中的数值）
  - 🔬 该刊近期发表过的相关主题
  - ⏰ 审稿周期与录用建议）

## 四、投稿实操指南
（150-200字。针对这个热点方向的投稿策略：选题角度建议、写作框架推荐、如何在Cover Letter中突出热点价值。）

## 五、总结：把握窗口期
（80-100字。强调学术热点有时效性，鼓励读者尽快行动。）

## 六、获取更多学术资讯
（30-50字。引导关注，语气专业。）`,

      compare: `【对比分析型 · 结构蓝图】

你必须严格按照以下6个章节依次输出，每个章节用 ## 二级标题，标题文字按要求写：

## 一、选刊纠结症？一篇文章帮你理清
（80-100字。描述读者面对多本期刊犹豫不决的场景，引出"系统对比"的必要性。）

## 二、核心数据一览表
（用 Markdown 表格对比所有期刊：
| 对比维度 | 期刊A | 期刊B | 期刊C |
|---------|------|------|------|
| 影响因子 | X.X | X.X | X.X |
| 分区 | XX | XX | XX |
| 录用率 | XX% | XX% | XX% |
| 审稿周期 | XX | XX | XX |
| 适合方向 | XX | XX | XX |
数据必须严格使用【严格数据约束】中的数值，没有的项标"—"。表格后用1-2句话概述总体差异。）

## 三、逐刊深度分析
（每本期刊150-200字，分析结构：
  **期刊名**
  ✅ 优势：2-3个亮点（如审稿快、录用率高、行业认可度强）
  ⚠️ 注意：1-2个需要注意的点（如版面费高、偏好特定方向）
  🎯 最适合：什么类型的稿件/作者
段落之间空行分隔。）

## 四、不同需求，不同选择
（150-180字。按3种典型场景给出推荐：
  **赶时间毕业** → 推荐审稿最快的期刊
  **追求学术影响力** → 推荐IF最高或分区最好的
  **稳妥为主** → 推荐录用率最高的
每种场景用 **加粗** 标明适合人群。）

## 五、总结
（60-80字。一句话概括各刊定位差异，帮助读者快速决策。）

## 六、需要个性化推荐？
（30-50字。引导咨询。）`,

      guide: `【速发攻略型 · 结构蓝图】

你必须严格按照以下7个章节依次输出，每个章节用 ## 二级标题，标题文字按要求写：

## 一、论文发表，为什么总是"慢人一步"？
（100-120字。列出3个造成发表慢的真实原因：选错期刊、格式不达标被退修、审稿周期长。用具体时间数字增加说服力，如"一次退修就多等2个月"。）

## 二、快速录用期刊精选
（主体部分，每本期刊120-180字。突出"速度"维度：
  **期刊名**
  - ⏰ 审稿周期：XX（用【严格数据约束】中的数值）
  - 📊 录用率：XX%
  - 📝 适合稿件类型
  - 🚀 加速技巧：针对该刊的投稿提速建议
按审稿速度从快到慢排序。）

## 三、提高一次通过率的5个技巧
（250-300字。给出5条具体可执行的建议：
  **1. 严格匹配期刊scope**（如何判断稿件是否匹配）
  **2. 格式一步到位**（参考文献格式、图表规范）
  **3. 写好Cover Letter**（模版要点）
  **4. 善用审稿意见**（如何高效回复Reviewer）
  **5. 选对投稿时间窗口**（避开年底审稿高峰）
每条建议80-100字，有可操作性。）

## 四、从投稿到见刊：时间规划表
（用简洁时间线展示：
  📅 第1周：完成终稿 + 选定期刊
  📅 第2-3周：格式调整 + 投稿
  📅 第4-8周：等待初审（根据期刊不同）
  📅 第9-10周：修改回复
  📅 第11-12周：录用 + 见刊
给出乐观和保守两种估计。）

## 五、常见"坑"提醒
（80-100字。提醒2-3个加速投稿容易踩的坑：如盲目投低门槛期刊反而被鄙视、一稿多投的严重后果。用 > 引用块突出。）

## 六、总结
（60-80字。鼓励读者按计划执行，强调"选对刊 + 格式对 = 速度快"。）

## 七、专业投稿辅导
（30-50字。引导咨询，提及"一对一选刊""格式代排"等服务。）`,
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

    // ============ System Prompt: 定义AI角色和全局规范 ============
    const systemPrompt = `你是"学术投稿指南"公众号的首席内容编辑。你拥有10年学术出版行业经验，精通国内核心期刊（北核、南核、CSCD、科技核心）和国际SCI/SSCI期刊的投稿规则。

## 你的身份
- 服务对象：需要发表论文的硕博研究生、青年教师、科研工作者
- 写作定位：专业、可信赖、有干货，像一位经验丰富的学长在分享投稿心得
- 语言风格：学术严谨但不晦涩，用通俗语言解释专业概念，适当使用 emoji 增加亲切感

## 写作铁律（必须遵守）
1. **数据零容差**：文中出现的任何期刊数据（IF、分区、录用率、审稿周期）必须与用户提供的【严格数据约束】完全一致，一个数字都不能改。如果某项数据未提供，绝对不要编造，直接跳过该数据项。
2. **结构即权威**：严格按照用户指定的【文章结构蓝图】输出，不要合并章节、不要跳过章节、不要自行添加章节。每个章节的字数要符合蓝图中的要求。
3. **SEO友好**：标题和前100字要自然包含核心关键词；每个 ## 标题包含与主题相关的长尾词；段落首句包含关键信息。
4. **格式规范**：使用纯 Markdown 格式，## 二级标题分节，**加粗** 突出关键信息，> 引用块用于提示/警告，表格用标准 Markdown 语法。不要输出代码块标记。
5. **字数控制**：总字数 1000-1500 字（不含标题和Markdown标记），每个章节严格按蓝图标注的字数范围。
6. **原创自然**：内容必须原创，不要出现"作为AI""本文将"等元叙述，直接以作者身份写作。`;

    const userPrompt = `请根据以下信息撰写一篇公众号图文文章。

# 文章标题
${title}

# 核心关键词
${keywords.join("、")}

# 学科领域
${discipline || "综合"} | 业务线: ${track === "domestic" ? "国内核心期刊" : "国际SCI/SSCI期刊"}
${dataConstraint}

# 文章结构蓝图（必须严格遵循）
${templateGuide}
${stylePrompt ? `\n# 风格指令（来自AI学习的模版，请严格遵循）\n${stylePrompt}` : ""}

# 输出要求
- 直接输出文章内容，以 # 标题 开头
- 纯 Markdown 格式，不要加 \`\`\`markdown 代码块
- 章节之间空一行
- 总字数 1000-1500 字`;

    try {
      // RAG: 从知识库检索相关知识注入 prompt
      let ragSection = "";
      try {
        const rag = await retrieveForWorkflow({
          tenantId: request.tenantId,
          title,
          keywords,
          discipline,
        });
        if (rag.totalHits > 0) {
          ragSection = `\n\n# 知识库参考资料（请在写作时遵循以下信息）\n${rag.text}`;
          logger.info({ title, ragHits: rag.totalHits, sources: rag.sources }, "工作流 RAG 注入");
        }
      } catch (ragErr) {
        logger.warn({ err: ragErr }, "工作流 RAG 检索失败，跳过");
      }

      logger.info({ title, keywords, template }, "工作流：开始生成文章");

      const result = await provider.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt + ragSection },
        ],
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

      // === 期刊图片抓取（多源：LetPub → CrossRef → 数据卡片保底） ===
      const journalImages: Array<{ name: string; coverUrl: string | null; dataCardUri: string | null }> = [];
      if (journals.length > 0) {
        for (const j of journals) {
          let coverUrl: string | null = null;
          let dataCardUri: string | null = null;
          try {
            // 多源抓取封面图
            coverUrl = await fetchJournalCoverMultiSource(j.name);
          } catch {
            // 封面抓取失败不阻塞
          }

          // 如果没有封面图，生成数据卡片 SVG 作为保底插图
          if (!coverUrl) {
            try {
              const svg = generateJournalDataCard({
                name: j.name,
                nameEn: j.nameEn,
                impactFactor: j.impactFactor,
                partition: j.partition,
                acceptanceRate: j.acceptanceRate,
                reviewCycle: j.reviewCycle,
              });
              dataCardUri = svgToDataUri(svg);
            } catch { /* 数据卡片生成失败也不阻塞 */ }
          }

          journalImages.push({ name: j.name, coverUrl, dataCardUri });
          // 限速
          if (journals.indexOf(j) < journals.length - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // 在文章中每个期刊首次出现的段落后插入图片（封面图或数据卡片）
        const imagesToInsert = journalImages.filter((ji) => ji.coverUrl || ji.dataCardUri);
        if (imagesToInsert.length > 0) {
          const lines = finalContent.split("\n");
          const insertedJournals = new Set<string>();
          const newLines: string[] = [];

          const lineContainsJournal = (line: string, name: string): boolean => {
            if (line.includes(name)) return true;
            const stripped = line.replace(/[《》]/g, "");
            if (stripped.includes(name)) return true;
            const noSpace = line.replace(/\s/g, "");
            if (noSpace.includes(name.replace(/\s/g, ""))) return true;
            return false;
          };

          for (let i = 0; i < lines.length; i++) {
            newLines.push(lines[i]);
            for (const ji of imagesToInsert) {
              if (insertedJournals.has(ji.name)) continue;
              if (!lineContainsJournal(lines[i], ji.name)) continue;
              if (/^\s*\|[\s:-]+\|/.test(lines[i])) continue;
              if (lines[i].trim() === "" || /^#+\s*$/.test(lines[i].trim())) continue;

              let insertIdx = i;
              if (lines[i].trim().startsWith("|")) {
                while (insertIdx + 1 < lines.length && lines[insertIdx + 1].trim().startsWith("|")) {
                  newLines.push(lines[++insertIdx]);
                }
              }
              // 优先用封面图，没有则用数据卡片
              const imgUrl = ji.coverUrl || ji.dataCardUri;
              const altText = ji.coverUrl ? `${ji.name}封面` : `${ji.name}数据卡片`;
              newLines.push("");
              newLines.push(`![${altText}](${imgUrl})`);
              newLines.push("");
              insertedJournals.add(ji.name);
              i = insertIdx;
              break;
            }
          }
          finalContent = newLines.join("\n");
          logger.info({ inserted: insertedJournals.size, total: imagesToInsert.length }, "工作流：期刊图片注入完成");
        }
      }

      // 提取首图URL（用于微信公众号封面）：优先第一张封面图，其次数据卡片
      const heroImage = journalImages.find((ji) => ji.coverUrl)?.coverUrl
        || journalImages.find((ji) => ji.dataCardUri)?.dataCardUri
        || null;

      logger.info({ title, contentLength: finalContent.length }, "工作流：文章生成完成");

      return reply.send({
        code: "ok",
        data: {
          content: finalContent,
          title,
          keywords,
          template,
          model: "deepseek-chat",
          journalImages,
          heroImage,
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
    const tenantId = request.tenantId;
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
    const tenantId = request.tenantId;
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
    const tenantId = request.tenantId;
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
    const tenantId = request.tenantId;
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
    const tenantId = request.tenantId;
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
    const tenantId = request.tenantId;
    if (!tenantId) {
      return reply.status(401).send({ code: "NO_TENANT", message: "未找到租户" });
    }

    await db.delete(styleAnalyses).where(eq(styleAnalyses.tenantId, tenantId));
    await db.delete(learnedTemplates).where(eq(learnedTemplates.tenantId, tenantId));

    return reply.send({ code: "ok" });
  });
}
