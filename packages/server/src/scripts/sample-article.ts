/**
 * 6-25 文章样片: 一键走"三管齐下"生成一篇 → 打印标题+正文, 用来评估"像不像该号写的"。
 *   复制生产链路: ArticleSkill(内部走RAG检索) + 注入账号风格(styleProfile) + 标题DNA覆盖标题。
 * 用法(服务器 packages/server 下):
 *   pnpm sample:article --account "paper 咨询与发表"     # 用该号风格/RAG/领域选刊
 *   选填 --journal <id> --topic "自定义选题"
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { journals, platformAccounts } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID, SYSTEM_RECOMMENDATION_USER_ID } from "../config/system-recommendation.js";
import { initializeSkills, SkillRegistry } from "../services/skills/index.js";
import { buildPersonaSuffix } from "../services/skills/structure-variation.js";
import { generateTitles } from "../services/content-engine/title-generator.js";
import { selectCandidates } from "../services/recommendation/daily-cron.js";
import { journalDisciplineMatches } from "../services/journals/journal-sql.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  initializeSkills();
  const acctQ = arg("account");
  const jid = arg("journal");
  let topic = arg("topic");

  let tenantId = SYSTEM_RECOMMENDATION_TENANT_ID, userId = SYSTEM_RECOMMENDATION_USER_ID;
  let persona: string | undefined, styleProfile: string | undefined, disc: string | undefined, acctName = "";
  if (acctQ) {
    const [a] = await db.select().from(platformAccounts)
      .where(sql`(${platformAccounts.accountName} ILIKE ${"%" + acctQ + "%"} OR ${platformAccounts.id}::text = ${acctQ})`).limit(1);
    if (!a) { console.error(`❌ 没找到账号 ${acctQ}`); process.exitCode = 1; return; }
    tenantId = a.tenantId; acctName = a.accountName ?? acctQ;
    persona = a.persona ?? undefined; styleProfile = a.styleProfile ?? undefined;
    const ds = Array.isArray(a.disciplines) ? (a.disciplines as string[]) : []; disc = ds[0] ?? (a.discipline ?? undefined);
    console.log(`账号《${acctName}》 领域=${disc ?? "不限"} styleProfile=${styleProfile ? "✅已设" : "❌未设"}`);
    // 该号下的用户
    const { users } = await import("../models/schema.js");
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId)).limit(1);
    if (u) userId = u.id;
  }

  // 6-26 修: 原 discCond 用裸 "AND ..."/空 sql`` 塞进 and() → 空时 "and )" 语法错(42601)、有值双 AND。改条件数组拼接(同 sample-card/titles)。
  const conds = [eq(journals.status, "active"), isNotNull(journals.impactFactor)];
  // 7-28 (#5): 同 sample-titles —— 账号 disciplines 是学科码, ILIKE 原始列只抽得到国际刊。
  const discCond = journalDisciplineMatches(disc);
  if (discCond) conds.push(discCond);
  const [j] = jid
    ? await db.select().from(journals).where(eq(journals.id, jid)).limit(1)
    : await db.select().from(journals).where(and(...conds)).orderBy(sql`random()`).limit(1);
  if (!j) { console.error("❌ 没找到可用期刊"); process.exitCode = 1; return; }

  if (!topic) {
    const cands = await selectCandidates({ disciplines: disc ? [disc] : null, cooldownDays: 0, poolSize: 5 });
    topic = cands[0]?.keyword ?? (j.name ?? j.nameEn ?? "期刊推荐");
  }
  console.log(`\n📝 生成中… 期刊《${j.name ?? j.nameEn}》(IF=${j.impactFactor ?? "—"})  选题: ${topic}  (最多180秒)\n`);

  // 🔎 第三管探针(6-26): 直接查 content_format, 确认"写法参考"有没有真命中 — 暴露类目/租户错配, 别再静默
  try {
    const { retrieveForArticle } = await import("../services/knowledge/rag-retriever.js");
    const probe = await retrieveForArticle({ tenantId, topic: topic!, keywords: disc ? [disc] : [] });
    const cf = probe.sources.find((x) => x.category === "content_format");
    console.log(`\n🔎 RAG探针: 写法参考(content_format) 命中 ${cf?.count ?? 0} 篇 | 全子库: ${probe.sources.map((x) => `${x.category}:${x.count}`).join(", ") || "全空"}`);
    if (!cf) console.log("   ⚠️ 写法参考 0 命中 → 第三管没生效! 排查: ①语料是否按 --account 灌进该号tenant ②ingest 类目是否 content_format ③重灌: pnpm ingest:wechat --account \"" + acctName + "\"");
  } catch (e) { console.log("🔎 RAG探针失败:", e instanceof Error ? e.message : e); }

  const article = SkillRegistry.get("article");
  if (!article) { console.error("❌ ArticleSkill 未注册(检查 LLM provider/key)"); process.exitCode = 1; return; }
  const personaPrompt = buildPersonaSuffix(persona, styleProfile);
  const skillContext = { tenantId, user: { userId, role: "owner" }, metadata: { journalId: j.id, ...(personaPrompt ? { personaPrompt } : {}) } };

  const result = await Promise.race([
    (article as any).handle(topic, [], skillContext) as Promise<{ artifact?: { body?: string; title?: string; metadata?: { videoScript?: string } } }>,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("生成超时180秒")), 180_000)),
  ]);
  let title = result.artifact?.title ?? topic;
  const body = result.artifact?.body ?? "(无正文)";
  const videoScript = result.artifact?.metadata?.videoScript;

  // 标题DNA覆盖(与生产 batch-worker 一致)
  try {
    const titles = await generateTitles({
      tenantId, userId, styleProfile, count: 3,
      journal: { name: j.name, nameEn: j.nameEn, publisher: (j as any).publisher,
        casPartition: (j as any).casPartitionNew ?? (j as any).casPartition, jcrPartition: (j as any).jcrSubjects,
        impactFactor: j.impactFactor, reviewCycle: (j as any).reviewCycle, acceptanceRate: (j as any).acceptanceRate,
        selfCitationRate: (j as any).selfCitationRate, discipline: (j as any).discipline },
    });
    if (titles[0]) title = titles[0];
  } catch { /* 保留原标题 */ }

  // P0四件套(7-03): 与生产 batch-worker 一致 — 生成后跑 ④压缩→③去AI腔→①六维质检+重写闭环, 并打印六维分数明细(验收工具)
  let finalBody = body;
  try {
    const { runArticleQualityPasses } = await import("../services/content-engine/quality-pipeline.js");
    const { SIX_DIM_LABELS, SIX_DIM_WEIGHTS } = await import("../services/content-engine/quality-check-v2.js");
    const qp = await runArticleQualityPasses({ tenantId, userId, title, body, journalId: j.id });
    finalBody = qp.body;
    console.log("══════════════ 六维质检(老韩标准) ══════════════");
    if (qp.sixDim) {
      for (const k of Object.keys(qp.sixDim.dims) as Array<keyof typeof qp.sixDim.dims>) {
        const d = qp.sixDim.dims[k];
        console.log(`  ${SIX_DIM_LABELS[k]}(${SIX_DIM_WEIGHTS[k]}%): ${d.score}/10${d.score < 8 ? `  ⚠️ 最弱: ${d.weakestSection} → ${d.fixHint}` : ""}`);
      }
      console.log(`  ─ 总分: ${qp.sixDim.totalScore}/100  ${qp.sixDim.passed ? "✅ 过80分线" : "❌ 未过(需≥80且无维度<6)"}${qp.sixDim.degraded ? "（⚠️ 评分降级, 分数不可信）" : ""}`);
      console.log(`  ─ 数据密度: ${qp.sixDim.dataDensity}`);
    }
    console.log(`  ─ 压缩: ${qp.condense.applied ? `已压缩(比例${qp.condense.ratio?.toFixed(2)})` : `未压缩(${qp.condense.reason})`} | AI腔命中: ${qp.decliche.hits}${qp.decliche.rewritten ? "(已清洗)" : ""} | 重写轮数: ${qp.qualityLoop.rounds} | 本次新增LLM调用: ${qp.llmCalls}`);
  } catch (e) { console.log("⚠️ P0四件套流水线失败(样片继续):", e instanceof Error ? e.message : e); }

  // 7-03 ⑥: 冒烟排版/口吻指标 — 验收"短段落 + 图文交替 + 小编口吻"
  try {
    const paras = Array.from(finalBody.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim())
      .filter((t) => t.length > 0);
    const avgLen = paras.length ? Math.round(paras.reduce((a, b) => a + b.length, 0) / paras.length) : 0;
    const longParas = paras.filter((t) => t.length > 150).length;
    const imgSlotHits = (finalBody.match(/<!--img-slot:(\w+)-->/g) || []).length;
    const leftoverMarkers = (finalBody.match(/\{\{\s*IMG\s*:/gi) || []).length;
    const imgTags = (finalBody.match(/<img\b/gi) || []).length;
    const plainAll = finalBody.replace(/<[^>]+>/g, "");
    const voiceWords = ["说实话", "我翻了", "划重点", "注意", "讲真", "坦白说"];
    const voiceHits = voiceWords.reduce((n, w) => n + (plainAll.split(w).length - 1), 0);
    const density = plainAll.length > 0 ? (voiceHits / (plainAll.length / 1000)).toFixed(2) : "0";
    console.log("══════════ 排版/口吻冒烟指标(7-03) ══════════");
    console.log(`  段落数: ${paras.length} | 平均段长: ${avgLen} 字 | >150字长段: ${longParas} 个${longParas > 0 ? " ⚠️(要求每段≤3句/≤100字)" : " ✅"}`);
    console.log(`  图位命中: ${imgSlotHits} 个 | <img>总数: ${imgTags} | 残留字面标记: ${leftoverMarkers}${leftoverMarkers > 0 ? " ⚠️ 有 {{IMG:}} 泄漏!" : " ✅"}`);
    console.log(`  小编语气词: ${voiceHits} 处 ≈ ${density} 处/千字${voiceHits === 0 ? " ⚠️ 口吻可能还是论文腔" : ""} (统计词: ${voiceWords.join("/")})`);
  } catch { /* 指标统计失败不影响样片 */ }

  console.log("══════════════ 标题 ══════════════");
  console.log(title);
  console.log("══════════════ 正文 ══════════════");
  console.log(finalBody.replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim());
  console.log("════════════ 数字人口播稿 ════════════");
  if (videoScript && videoScript.trim()) {
    const vs = videoScript.trim();
    console.log(vs);
    console.log(`\n[口播稿 ${vs.length} 字 ≈ ${Math.round(vs.length / 4)} 秒 ≈ ${(Math.round(vs.length / 4) * 0.165).toFixed(1)} 元 DVH 合成费]`);
  } else {
    console.log("(本篇未生成 videoScript — 检查 prompt 或 LLM 输出)");
  }
  console.log("══════════════════════════════════");
  console.log("\n👉 把【标题+正文】和【口播稿】分别贴给 Claude 打分。口播稿读顺了再跑 pnpm sample:dvh --yes 渲染数字人(花钱)。\n");
}
main().then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => { console.error("生成异常:", e instanceof Error ? e.message : e); await closePool(); process.exit(1); });
