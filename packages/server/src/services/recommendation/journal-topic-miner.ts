/**
 * 6-19 选题库自动扩充(零人工): 从 8744 期刊库随机抽样, 用 LLM 按"学科+收稿范围"衍生选题, 入 keywords。
 *   ③ 选题飞轮: 入库初始分按"该学科过往内容表现"(content_metrics 阅读/互动)加权 ——
 *   表现好的学科衍生的选题起点更高 → selectCandidates(按 compositeScore 排序)自然优先 → 越用越准。
 *   复用 recommendTopics(单刊→LLM 推题) + keywords 入库 upsert。不需要老韩每次手动喂文稿/对标账号。
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords as keywordsTable, journals } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { recommendTopics } from "./topic-recommender.js";
import { logger } from "../../config/logger.js";

const BASE_SCORE = 45; // 衍生选题初始综合分(放中游, 与爬虫热词公平竞争)
const POOL_CAP = Number(process.env.JOURNAL_TOPIC_POOL_CAP) || 1500; // journal_mining 选题池上限, 防无上限增长

/** ③ 学科表现因子: 各学科过往内容 avg(阅读/互动代理) ÷ 全局均值, clamp 到 [0.7, 1.5]。无数据=全 1。 */
async function categoryFactors(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await db.execute(sql`
      SELECT c.metadata->>'discipline' AS disc,
             AVG(GREATEST(cm.views, cm.likes*10 + cm.comments*15 + cm.shares*20)) AS av
      FROM content_metrics cm JOIN contents c ON c.id = cm.content_id
      WHERE c.metadata->>'discipline' IS NOT NULL
      GROUP BY 1`);
    const rows = ((res as any).rows ?? []) as Array<{ disc: string; av: string }>;
    const vals = rows.map((r) => Number(r.av) || 0).filter((v) => v > 0);
    if (vals.length === 0) return map;
    const overall = vals.reduce((s, v) => s + v, 0) / vals.length;
    if (overall <= 0) return map;
    for (const r of rows) {
      const av = Number(r.av) || 0;
      if (av <= 0 || !r.disc) continue;
      map.set(r.disc, Math.max(0.7, Math.min(1.5, av / overall)));
    }
  } catch (err) { logger.warn({ err: String(err) }, "journal-topic-miner: 学科表现聚合失败(因子全1)"); }
  return map;
}

/** 封顶淘汰: 保留最多 POOL_CAP 个 active 衍生选题, 多余的归档(优先淘汰 从未被推荐+低分+最老)。
 *  用过的(lastRecommendedAt 非空)、高分、近期的留下 → 池子有界且自动汰旧留优, 不无限增长。 */
async function evictExcess(sysTenant: string): Promise<number> {
  try {
    const res = await db.execute(sql`
      UPDATE keywords SET status = 'archived'
      WHERE id IN (
        SELECT id FROM keywords
        WHERE tenant_id = ${sysTenant}::uuid AND source_platform = 'journal_mining' AND status = 'active'
        ORDER BY (last_recommended_at IS NOT NULL) DESC, composite_score DESC, created_at DESC
        OFFSET ${POOL_CAP}
      )`);
    const n = (res as any).rowCount ?? 0;
    if (n > 0) logger.info({ archived: n, cap: POOL_CAP }, "journal-topic-miner: 超上限归档旧选题");
    return n;
  } catch (err) { logger.warn({ err: String(err) }, "journal-topic-miner: 淘汰失败(不阻塞)"); return 0; }
}

/** 主入口: 抽样期刊 → LLM 衍生选题 → 入 keywords(按学科表现加权)。 */
export async function mineTopicsFromJournals(opts?: { sampleJournals?: number; topicsPerJournal?: number }): Promise<{ journals: number; inserted: number; updated: number; archived: number }> {
  const SYS = SYSTEM_RECOMMENDATION_TENANT_ID;
  const sampleN = opts?.sampleJournals ?? 12;
  const perJournal = opts?.topicsPerJournal ?? 3;

  const factors = await categoryFactors();
  const sampled = await db.select({ id: journals.id, discipline: journals.discipline })
    .from(journals)
    .where(and(eq(journals.status, "active"), sql`${journals.dataSource} IS DISTINCT FROM 'ai_fabricated'`))
    .orderBy(sql`random()`)
    .limit(sampleN);

  let inserted = 0, updated = 0;
  for (const j of sampled) {
    let topics: Array<{ topic: string; reason: string }> = [];
    try { topics = await recommendTopics({ tenantId: SYS, journalId: j.id, limit: perJournal }); }
    catch (err) { logger.warn({ journalId: j.id, err: String(err) }, "journal-topic-miner: 单刊推题失败(跳过)"); continue; }
    const factor = (j.discipline && factors.get(j.discipline)) || 1;
    const score = Math.round(BASE_SCORE * factor);
    for (const t of topics) {
      const kw = (t.topic || "").trim().slice(0, 200);
      if (kw.length < 4) continue;
      try {
        const [exist] = await db.select({ id: keywordsTable.id, appearCount: keywordsTable.appearCount })
          .from(keywordsTable)
          .where(and(eq(keywordsTable.tenantId, SYS), sql`LOWER(${keywordsTable.keyword}) = LOWER(${kw})`))
          .limit(1);
        if (exist) {
          await db.update(keywordsTable)
            .set({ appearCount: (exist.appearCount ?? 0) + 1, lastSeenAt: new Date() })
            .where(eq(keywordsTable.id, exist.id));
          updated++;
        } else {
          await db.insert(keywordsTable).values({
            tenantId: SYS, keyword: kw, sourcePlatform: "journal_mining",
            heatScore: score, compositeScore: score, category: j.discipline ?? null, status: "active",
            crawlDate: new Date().toISOString().slice(0, 10),
          });
          inserted++;
        }
      } catch (err) { logger.warn({ kw, err: String(err) }, "journal-topic-miner: 入库失败(跳过)"); }
    }
  }
  const archived = inserted > 0 ? await evictExcess(SYS) : 0;
  logger.info({ journals: sampled.length, inserted, updated, archived }, "journal-topic-miner: 期刊衍生选题完成");
  return { journals: sampled.length, inserted, updated, archived };
}
