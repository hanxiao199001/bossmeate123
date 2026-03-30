/**
 * 期刊中心 API
 *
 * 对齐詹金晶的工作流：
 * 1. 按学科 + 分区 + 影响因子筛选期刊
 * 2. 按查看数/热度排序
 * 3. 检查是否在中科院预警名单
 * 4. 选刊 → 找噱头 → 出标题
 */

import type { FastifyInstance } from "fastify";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { eq, and, sql, gte, lte, ilike, desc, asc } from "drizzle-orm";
import { logger } from "../config/logger.js";

export async function journalRoutes(app: FastifyInstance) {
  // ============ 获取期刊列表（筛选+排序）============
  app.get("/journals", async (request, reply) => {
    const {
      discipline,     // 学科: medicine | education | engineering ...
      partition,       // 分区: Q1 | Q2 | Q3 | Q4
      ifMin,          // 影响因子最小值
      ifMax,          // 影响因子最大值
      warningOnly,    // 只看预警期刊
      safeOnly,       // 只看非预警期刊
      keyword,        // 搜索关键词（期刊名/ISSN）
      sortBy,         // 排序字段: views | if | acceptance
      page = 1,
      pageSize = 20,
    } = request.query as Record<string, string>;

    const tenantId = (request as any).tenantId;
    const conditions: any[] = [eq(journals.tenantId, tenantId)];

    if (discipline) conditions.push(eq(journals.discipline, discipline));
    if (partition) conditions.push(eq(journals.partition, partition));
    if (ifMin) conditions.push(gte(journals.impactFactor, parseFloat(ifMin)));
    if (ifMax) conditions.push(lte(journals.impactFactor, parseFloat(ifMax)));
    if (warningOnly === "true") conditions.push(eq(journals.isWarningList, true));
    if (safeOnly === "true") conditions.push(eq(journals.isWarningList, false));
    if (keyword) {
      conditions.push(
        sql`(${ilike(journals.name, `%${keyword}%`)} OR ${ilike(journals.nameEn, `%${keyword}%`)} OR ${journals.issn} = ${keyword})`
      );
    }

    // 排序
    let orderClause;
    switch (sortBy) {
      case "views": orderClause = desc(journals.letpubViews); break;
      case "if": orderClause = desc(journals.impactFactor); break;
      case "acceptance": orderClause = desc(journals.acceptanceRate); break;
      case "peer": orderClause = desc(journals.peerWriteCount); break;
      default: orderClause = desc(journals.letpubViews);
    }

    const pageNum = parseInt(String(page), 10) || 1;
    const size = parseInt(String(pageSize), 10) || 20;

    const results = await db
      .select()
      .from(journals)
      .where(and(...conditions))
      .orderBy(orderClause)
      .limit(size)
      .offset((pageNum - 1) * size);

    const countResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(journals)
      .where(and(...conditions));

    return reply.send({
      code: "ok",
      data: {
        items: results,
        total: Number(countResult[0]?.count || 0),
        page: pageNum,
        pageSize: size,
      },
    });
  });

  // ============ 获取单个期刊详情 ============
  app.get("/journals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = (request as any).tenantId;

    const result = await db
      .select()
      .from(journals)
      .where(and(eq(journals.id, id), eq(journals.tenantId, tenantId)))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "期刊不存在" });
    }

    return reply.send({ code: "ok", data: result[0] });
  });

  // ============ 检查期刊预警状态 ============
  app.get("/journals/:id/warning-check", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = (request as any).tenantId;

    const result = await db
      .select({
        name: journals.name,
        nameEn: journals.nameEn,
        isWarningList: journals.isWarningList,
        warningYear: journals.warningYear,
        impactFactor: journals.impactFactor,
        partition: journals.partition,
      })
      .from(journals)
      .where(and(eq(journals.id, id), eq(journals.tenantId, tenantId)))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "期刊不存在" });
    }

    const journal = result[0];
    const warnings: string[] = [];
    let safeLevel: "safe" | "caution" | "danger" = "safe";

    if (journal.isWarningList) {
      warnings.push(`该期刊在中科院${journal.warningYear || ""}预警名单中，建议避开`);
      safeLevel = "danger";
    }
    if (journal.impactFactor && journal.impactFactor > 10) {
      warnings.push(`影响因子 ${journal.impactFactor} 偏高（建议选10以下），目标客户可能发不了`);
      safeLevel = safeLevel === "danger" ? "danger" : "caution";
    }
    if (journal.impactFactor && journal.impactFactor < 0.5) {
      warnings.push(`影响因子过低 (${journal.impactFactor})，可能影响内容吸引力`);
      safeLevel = safeLevel === "danger" ? "danger" : "caution";
    }

    return reply.send({
      code: "ok",
      data: {
        ...journal,
        safeLevel,
        warnings,
        recommendation: safeLevel === "safe"
          ? "✅ 该期刊安全，适合作为选题方向"
          : safeLevel === "caution"
            ? "⚠️ 该期刊需要注意上述问题"
            : "❌ 建议避开该期刊",
      },
    });
  });

  // ============ 获取学科列表（用于筛选器）============
  app.get("/journals/meta/disciplines", async (request, reply) => {
    const tenantId = (request as any).tenantId;

    const result = await db
      .select({
        discipline: journals.discipline,
        count: sql<number>`COUNT(*)`,
      })
      .from(journals)
      .where(eq(journals.tenantId, tenantId))
      .groupBy(journals.discipline)
      .orderBy(sql`COUNT(*) DESC`);

    return reply.send({ code: "ok", data: result });
  });

  // ============ 根据关键词智能匹配期刊 ============
  app.post("/journals/match", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const { keywords, track, discipline } = request.body as {
      keywords: string[];
      track?: "domestic" | "sci" | "all";
      discipline?: string;
    };

    if (!keywords || keywords.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "keywords 不能为空" });
    }

    // 学科中文 → 英文映射
    const disciplineMap: Record<string, string> = {
      "医学": "medicine",
      "教育": "education",
      "工程技术": "engineering",
      "计算机": "engineering",
      "经济管理": "economics",
      "法学": "law",
      "心理学": "psychology",
      "生物": "biology",
      "化学": "chemistry",
      "物理": "physics",
      "能源": "energy",
      "环境科学": "environment",
      "农林": "agriculture",
      "材料科学": "materials",
      "数学": "math",
    };

    const conditions: any[] = [eq(journals.tenantId, tenantId)];

    // 按学科筛选
    if (discipline) {
      const enDiscipline = disciplineMap[discipline] || discipline;
      conditions.push(eq(journals.discipline, enDiscipline));
    }

    // 按业务线筛选影响因子范围（国内核心客户一般投IF<10的期刊）
    if (track === "domestic") {
      conditions.push(lte(journals.impactFactor, 10));
    }

    // 先按学科查所有期刊
    const allJournals = await db
      .select()
      .from(journals)
      .where(and(...conditions))
      .orderBy(desc(journals.letpubViews))
      .limit(100);

    // 用关键词对期刊名做模糊匹配打分
    const scored = allJournals.map((j) => {
      let matchScore = 0;
      const jName = `${j.name || ""} ${j.nameEn || ""}`.toLowerCase();

      for (const kw of keywords) {
        // 拆分关键词为子词
        const subWords = kw.replace(/论文|期刊|核心|参考文献|发表|速发|指南/g, "").trim().split(/\s+/);
        for (const w of subWords) {
          if (w.length >= 2 && jName.includes(w.toLowerCase())) {
            matchScore += 10;
          }
        }
      }

      // 基础分：查看量归一化 + 录用率加分 + 非预警加分
      const viewScore = Math.min((j.letpubViews || 0) / 5000, 10);
      const acceptScore = (j.acceptanceRate || 0) * 10;
      const safeBonus = j.isWarningList ? -5 : 2;

      // 中等IF加分（客户容易投中的2-8范围）
      const ifVal = j.impactFactor || 0;
      const ifBonus = (ifVal >= 2 && ifVal <= 8) ? 5 : (ifVal > 0 && ifVal < 2) ? 3 : 0;

      return {
        ...j,
        matchScore: matchScore + viewScore + acceptScore + safeBonus + ifBonus,
        matchReason: matchScore > 0 ? "关键词匹配" : "学科热门",
      };
    });

    // 按综合分排序
    scored.sort((a, b) => b.matchScore - a.matchScore);

    // 返回前20条
    const top = scored.slice(0, 20);

    return reply.send({
      code: "ok",
      data: {
        items: top,
        total: top.length,
        keywords,
        discipline: discipline || "全部",
        track: track || "all",
      },
    });
  });

  // ============ 导入种子期刊数据 ============
  app.post("/journals/seed", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const { force } = (request.body || {}) as { force?: boolean };

    // 检查是否已经有数据
    const existing = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(journals)
      .where(eq(journals.tenantId, tenantId));

    if (Number(existing[0]?.count) > 0 && !force) {
      return reply.send({
        code: "ok",
        message: `已有 ${existing[0].count} 条期刊数据，跳过导入`,
      });
    }

    // 种子数据：覆盖常用的学科领域
    const seedJournals = getSeedJournals(tenantId);

    // 获取当前已有期刊名，避免重复插入
    const existingJournals = await db
      .select({ name: journals.name })
      .from(journals)
      .where(eq(journals.tenantId, tenantId));
    const existingNames = new Set(existingJournals.map((j) => j.name));

    let insertedCount = 0;
    for (const j of seedJournals) {
      if (existingNames.has(j.name)) continue; // 跳过已存在的
      try {
        await db.insert(journals).values(j);
        insertedCount++;
      } catch {
        // 忽略个别插入失败
      }
    }

    logger.info({ total: seedJournals.length, inserted: insertedCount }, "期刊种子数据导入完成");

    return reply.send({
      code: "ok",
      message: insertedCount > 0
        ? `新增 ${insertedCount} 条期刊数据（共 ${seedJournals.length} 条种子）`
        : `所有种子数据已存在，无需导入`,
      data: { count: insertedCount },
    });
  });
}

/**
 * 种子期刊数据
 * 对齐詹金晶的工作场景：医学、教育、工程、经济管理等热门学科
 * 包含预警期刊、高IF期刊、容易录用期刊等各种类型
 */
function getSeedJournals(tenantId: string) {
  return [
    // ===== 医学（她的主要领域）=====
    { tenantId, name: "柳叶刀", nameEn: "The Lancet", issn: "0140-6736", publisher: "Elsevier", discipline: "medicine", partition: "Q1", impactFactor: 98.4, annualVolume: 800, acceptanceRate: 0.05, reviewCycle: "4-8周", isWarningList: false, letpubViews: 58000, source: "seed" },
    { tenantId, name: "新英格兰医学杂志", nameEn: "NEJM", issn: "0028-4793", publisher: "Massachusetts Medical Society", discipline: "medicine", partition: "Q1", impactFactor: 96.2, annualVolume: 600, acceptanceRate: 0.04, reviewCycle: "2-4周", isWarningList: false, letpubViews: 52000, source: "seed" },
    { tenantId, name: "英国医学杂志", nameEn: "BMJ", issn: "0959-8138", publisher: "BMJ Publishing", discipline: "medicine", partition: "Q1", impactFactor: 39.9, annualVolume: 1200, acceptanceRate: 0.07, reviewCycle: "4-6周", isWarningList: false, letpubViews: 45000, source: "seed" },
    { tenantId, name: "美国医学会杂志", nameEn: "JAMA", issn: "0098-7484", publisher: "AMA", discipline: "medicine", partition: "Q1", impactFactor: 63.1, annualVolume: 900, acceptanceRate: 0.06, reviewCycle: "3-6周", isWarningList: false, letpubViews: 48000, source: "seed" },
    { tenantId, name: "自然医学", nameEn: "Nature Medicine", issn: "1078-8956", publisher: "Springer Nature", discipline: "medicine", partition: "Q1", impactFactor: 58.7, annualVolume: 500, acceptanceRate: 0.08, reviewCycle: "6-10周", isWarningList: false, letpubViews: 42000, source: "seed" },
    // 医学中等IF（她常选的范围：IF < 10）
    { tenantId, name: "医学前沿", nameEn: "Frontiers in Medicine", issn: "2296-858X", publisher: "Frontiers", discipline: "medicine", partition: "Q2", impactFactor: 3.9, annualVolume: 5000, acceptanceRate: 0.45, reviewCycle: "6-8周", isWarningList: false, letpubViews: 32000, source: "seed" },
    { tenantId, name: "公共卫生前沿", nameEn: "Frontiers in Public Health", issn: "2296-2565", publisher: "Frontiers", discipline: "medicine", partition: "Q2", impactFactor: 3.0, annualVolume: 6000, acceptanceRate: 0.50, reviewCycle: "5-7周", isWarningList: false, letpubViews: 28000, source: "seed" },
    { tenantId, name: "国际环境研究与公共卫生杂志", nameEn: "Int J Environ Res Public Health", issn: "1660-4601", publisher: "MDPI", discipline: "medicine", partition: "Q3", impactFactor: 3.4, annualVolume: 15000, acceptanceRate: 0.55, reviewCycle: "3-5周", isWarningList: true, warningYear: "2023", letpubViews: 38000, source: "seed" },
    { tenantId, name: "医学", nameEn: "Medicine", issn: "0025-7974", publisher: "Lippincott", discipline: "medicine", partition: "Q3", impactFactor: 1.6, annualVolume: 8000, acceptanceRate: 0.60, reviewCycle: "2-4周", isWarningList: false, letpubViews: 35000, source: "seed" },
    { tenantId, name: "BMC医学", nameEn: "BMC Medicine", issn: "1741-7015", publisher: "BioMed Central", discipline: "medicine", partition: "Q1", impactFactor: 7.8, annualVolume: 400, acceptanceRate: 0.15, reviewCycle: "4-8周", isWarningList: false, letpubViews: 25000, source: "seed" },
    { tenantId, name: "肿瘤前沿", nameEn: "Frontiers in Oncology", issn: "2234-943X", publisher: "Frontiers", discipline: "medicine", partition: "Q2", impactFactor: 4.7, annualVolume: 4500, acceptanceRate: 0.42, reviewCycle: "6-10周", isWarningList: false, letpubViews: 30000, source: "seed" },
    { tenantId, name: "肿瘤学年鉴", nameEn: "Annals of Oncology", issn: "0923-7534", publisher: "Oxford", discipline: "medicine", partition: "Q1", impactFactor: 32.0, annualVolume: 600, acceptanceRate: 0.10, reviewCycle: "4-6周", isWarningList: false, letpubViews: 22000, source: "seed" },

    // ===== 教育 =====
    { tenantId, name: "教育研究评论", nameEn: "Review of Educational Research", issn: "0034-6543", publisher: "SAGE", discipline: "education", partition: "Q1", impactFactor: 11.2, annualVolume: 80, acceptanceRate: 0.08, reviewCycle: "8-12周", isWarningList: false, letpubViews: 15000, source: "seed" },
    { tenantId, name: "计算机与教育", nameEn: "Computers & Education", issn: "0360-1315", publisher: "Elsevier", discipline: "education", partition: "Q1", impactFactor: 8.9, annualVolume: 300, acceptanceRate: 0.12, reviewCycle: "6-10周", isWarningList: false, letpubViews: 18000, source: "seed" },
    { tenantId, name: "教育前沿", nameEn: "Frontiers in Education", issn: "2504-284X", publisher: "Frontiers", discipline: "education", partition: "Q3", impactFactor: 1.9, annualVolume: 1500, acceptanceRate: 0.50, reviewCycle: "4-6周", isWarningList: false, letpubViews: 12000, source: "seed" },
    { tenantId, name: "高等教育研究", nameEn: "Studies in Higher Education", issn: "0307-5079", publisher: "Taylor & Francis", discipline: "education", partition: "Q1", impactFactor: 4.4, annualVolume: 200, acceptanceRate: 0.15, reviewCycle: "6-10周", isWarningList: false, letpubViews: 14000, source: "seed" },

    // ===== 工程/计算机 =====
    { tenantId, name: "IEEE Access", nameEn: "IEEE Access", issn: "2169-3536", publisher: "IEEE", discipline: "engineering", partition: "Q2", impactFactor: 3.9, annualVolume: 25000, acceptanceRate: 0.45, reviewCycle: "4-6周", isWarningList: false, letpubViews: 40000, source: "seed" },
    { tenantId, name: "传感器", nameEn: "Sensors", issn: "1424-8220", publisher: "MDPI", discipline: "engineering", partition: "Q2", impactFactor: 3.4, annualVolume: 12000, acceptanceRate: 0.50, reviewCycle: "3-5周", isWarningList: false, letpubViews: 35000, source: "seed" },
    { tenantId, name: "应用科学", nameEn: "Applied Sciences", issn: "2076-3417", publisher: "MDPI", discipline: "engineering", partition: "Q3", impactFactor: 2.5, annualVolume: 20000, acceptanceRate: 0.55, reviewCycle: "3-5周", isWarningList: true, warningYear: "2024", letpubViews: 33000, source: "seed" },
    { tenantId, name: "自然通讯", nameEn: "Nature Communications", issn: "2041-1723", publisher: "Springer Nature", discipline: "engineering", partition: "Q1", impactFactor: 14.7, annualVolume: 8000, acceptanceRate: 0.18, reviewCycle: "8-16周", isWarningList: false, letpubViews: 50000, source: "seed" },

    // ===== 经济管理 =====
    { tenantId, name: "管理学季刊", nameEn: "Administrative Science Quarterly", issn: "0001-8392", publisher: "SAGE", discipline: "economics", partition: "Q1", impactFactor: 9.2, annualVolume: 40, acceptanceRate: 0.05, reviewCycle: "8-12周", isWarningList: false, letpubViews: 10000, source: "seed" },
    { tenantId, name: "可持续发展", nameEn: "Sustainability", issn: "2071-1050", publisher: "MDPI", discipline: "economics", partition: "Q2", impactFactor: 3.3, annualVolume: 18000, acceptanceRate: 0.50, reviewCycle: "3-5周", isWarningList: true, warningYear: "2024", letpubViews: 42000, source: "seed" },
    { tenantId, name: "管理学报", nameEn: "Journal of Management", issn: "0149-2063", publisher: "SAGE", discipline: "economics", partition: "Q1", impactFactor: 8.6, annualVolume: 120, acceptanceRate: 0.08, reviewCycle: "6-10周", isWarningList: false, letpubViews: 12000, source: "seed" },

    // ===== 法学 =====
    { tenantId, name: "中国法学", nameEn: "China Legal Science", issn: "1003-1707", publisher: "中国法学会", discipline: "law", partition: "Q1", impactFactor: 0, annualVolume: 80, acceptanceRate: 0.03, reviewCycle: "3-6个月", isWarningList: false, letpubViews: 16000, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "法学研究", nameEn: "Chinese Journal of Law", issn: "1002-896X", publisher: "中国社会科学院", discipline: "law", partition: "Q1", impactFactor: 0, annualVolume: 60, acceptanceRate: 0.03, reviewCycle: "3-6个月", isWarningList: false, letpubViews: 15000, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "法学评论", nameEn: "Law Review", issn: "1004-1303", publisher: "武汉大学", discipline: "law", partition: "Q2", impactFactor: 0, annualVolume: 100, acceptanceRate: 0.05, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 12000, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "政法论坛", nameEn: "Tribune of Political Science and Law", issn: "1000-0208", publisher: "中国政法大学", discipline: "law", partition: "Q2", impactFactor: 0, annualVolume: 80, acceptanceRate: 0.05, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 11000, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "现代法学", nameEn: "Modern Law Science", issn: "1001-2397", publisher: "西南政法大学", discipline: "law", partition: "Q2", impactFactor: 0, annualVolume: 90, acceptanceRate: 0.06, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 10000, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "法律科学", nameEn: "Science of Law", issn: "1674-5205", publisher: "西北政法大学", discipline: "law", partition: "Q2", impactFactor: 0, annualVolume: 80, acceptanceRate: 0.06, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 9000, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "环球法律评论", nameEn: "Global Law Review", issn: "1009-6728", publisher: "中国社会科学院", discipline: "law", partition: "Q2", impactFactor: 0, annualVolume: 60, acceptanceRate: 0.05, reviewCycle: "3-5个月", isWarningList: false, letpubViews: 8500, source: "seed", metadata: { type: "CSSCI" } },
    { tenantId, name: "比较法研究", nameEn: "Journal of Comparative Law", issn: "1004-8561", publisher: "中国政法大学", discipline: "law", partition: "Q3", impactFactor: 0, annualVolume: 60, acceptanceRate: 0.08, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 7500, source: "seed", metadata: { type: "CSSCI" } },

    // ===== 心理学 =====
    { tenantId, name: "心理学前沿", nameEn: "Frontiers in Psychology", issn: "1664-1078", publisher: "Frontiers", discipline: "psychology", partition: "Q2", impactFactor: 2.6, annualVolume: 8000, acceptanceRate: 0.48, reviewCycle: "5-8周", isWarningList: false, letpubViews: 28000, source: "seed" },

    // ===== 生物 =====
    { tenantId, name: "细胞", nameEn: "Cell", issn: "0092-8674", publisher: "Elsevier", discipline: "biology", partition: "Q1", impactFactor: 45.5, annualVolume: 500, acceptanceRate: 0.06, reviewCycle: "4-8周", isWarningList: false, letpubViews: 38000, source: "seed" },
    { tenantId, name: "自然", nameEn: "Nature", issn: "0028-0836", publisher: "Springer Nature", discipline: "biology", partition: "Q1", impactFactor: 50.5, annualVolume: 900, acceptanceRate: 0.07, reviewCycle: "4-8周", isWarningList: false, letpubViews: 55000, source: "seed" },
    { tenantId, name: "科学", nameEn: "Science", issn: "0036-8075", publisher: "AAAS", discipline: "biology", partition: "Q1", impactFactor: 44.7, annualVolume: 800, acceptanceRate: 0.06, reviewCycle: "4-8周", isWarningList: false, letpubViews: 52000, source: "seed" },

    // ===== 农林 =====
    { tenantId, name: "农业科学前沿", nameEn: "Frontiers in Plant Science", issn: "1664-462X", publisher: "Frontiers", discipline: "agriculture", partition: "Q1", impactFactor: 4.1, annualVolume: 4000, acceptanceRate: 0.40, reviewCycle: "5-8周", isWarningList: false, letpubViews: 26000, source: "seed" },
    { tenantId, name: "农业与食品化学杂志", nameEn: "Journal of Agricultural and Food Chemistry", issn: "0021-8561", publisher: "ACS", discipline: "agriculture", partition: "Q1", impactFactor: 5.7, annualVolume: 3000, acceptanceRate: 0.30, reviewCycle: "6-10周", isWarningList: false, letpubViews: 22000, source: "seed" },
    { tenantId, name: "作物学报", nameEn: "Acta Agronomica Sinica", issn: "0496-3490", publisher: "中国作物学会", discipline: "agriculture", partition: "Q3", impactFactor: 1.8, annualVolume: 300, acceptanceRate: 0.25, reviewCycle: "3-6个月", isWarningList: false, letpubViews: 16000, source: "seed" },
    { tenantId, name: "中国农业科学", nameEn: "Scientia Agricultura Sinica", issn: "0578-1752", publisher: "中国农业科学院", discipline: "agriculture", partition: "Q2", impactFactor: 2.5, annualVolume: 400, acceptanceRate: 0.20, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 19000, source: "seed" },
    { tenantId, name: "食品科学与技术", nameEn: "Food Science and Technology", issn: "0101-2061", publisher: "SBCTA", discipline: "agriculture", partition: "Q3", impactFactor: 2.1, annualVolume: 600, acceptanceRate: 0.45, reviewCycle: "4-6周", isWarningList: false, letpubViews: 14000, source: "seed" },
    { tenantId, name: "农业水管理", nameEn: "Agricultural Water Management", issn: "0378-3774", publisher: "Elsevier", discipline: "agriculture", partition: "Q1", impactFactor: 5.4, annualVolume: 500, acceptanceRate: 0.25, reviewCycle: "8-12周", isWarningList: false, letpubViews: 17000, source: "seed" },
    { tenantId, name: "动物科学杂志", nameEn: "Journal of Animal Science", issn: "0021-8812", publisher: "Oxford", discipline: "agriculture", partition: "Q2", impactFactor: 3.3, annualVolume: 800, acceptanceRate: 0.35, reviewCycle: "6-10周", isWarningList: false, letpubViews: 13000, source: "seed" },
    { tenantId, name: "园艺研究", nameEn: "Horticulture Research", issn: "2052-7276", publisher: "Oxford", discipline: "agriculture", partition: "Q1", impactFactor: 7.6, annualVolume: 300, acceptanceRate: 0.20, reviewCycle: "6-8周", isWarningList: false, letpubViews: 15000, source: "seed" },

    // ===== 中文核心（国内市场重要）=====
    { tenantId, name: "中华医学杂志", nameEn: "National Medical Journal of China", issn: "0376-2491", publisher: "中华医学会", discipline: "medicine", partition: "Q3", impactFactor: 2.4, annualVolume: 500, acceptanceRate: 0.15, reviewCycle: "3-6个月", isWarningList: false, letpubViews: 20000, source: "seed" },
    { tenantId, name: "北京大学学报(医学版)", nameEn: "Journal of Peking University (Health Sciences)", issn: "1671-167X", publisher: "北京大学", discipline: "medicine", partition: "Q4", impactFactor: 1.2, annualVolume: 200, acceptanceRate: 0.20, reviewCycle: "2-4个月", isWarningList: false, letpubViews: 15000, source: "seed" },
    { tenantId, name: "教育研究", nameEn: "Educational Research", issn: "1002-5731", publisher: "中国教育科学研究院", discipline: "education", partition: "Q1", impactFactor: 0, annualVolume: 120, acceptanceRate: 0.05, reviewCycle: "3-6个月", isWarningList: false, letpubViews: 18000, source: "seed", metadata: { type: "CSSCI" } },
  ];
}
