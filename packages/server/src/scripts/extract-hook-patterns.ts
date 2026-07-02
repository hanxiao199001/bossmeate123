/**
 * P0四件套②：从客户真实语料提炼钩子模式，补充/覆盖种子库
 *
 * 语料来源（按优先级）：
 *   1. monorepo 根 data/wechat-corpus/_full/corpus.json（ingest-wechat-corpus.ts 同源文件，467 篇）
 *   2. DB knowledge_entries（category=content_format，source LIKE 'wechat_history:%'）——
 *      服务器上没同步语料文件时的兜底
 *
 * 做法：每篇取开头 150 字，随机抽样 ≤60 篇 → 1 次 LLM 聚类提炼 6-10 个钩子模式
 * → 输出 JSON 到 packages/server/data/hook-patterns-learned.json。
 * 运行时 hook-patterns.ts 检测到该文件即与种子库合并使用（学到的优先）。
 *
 * 用法（packages/server 下）：
 *   pnpm exec tsx src/scripts/extract-hook-patterns.ts                 # 默认语料文件
 *   选填 --dir <corpus.json目录> --tenant <tenantId> --sample 60 --out <输出路径>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { chat } from "../services/ai/chat-service.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import type { HookPattern } from "../data/hook-patterns.js";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 读语料：优先本地 corpus.json，缺了兜底查 DB 知识库 */
async function loadOpenings(sampleN: number): Promise<string[]> {
  const dir = arg("dir") || "../../data/wechat-corpus/_full";
  const corpusPath = resolve(process.cwd(), dir, "corpus.json");

  let bodies: string[] = [];
  if (existsSync(corpusPath)) {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as Array<{ title: string; body: string; chars: number }>;
    bodies = corpus.filter((c) => c.chars >= 300).map((c) => `${c.title}\n${c.body}`);
    console.log(`📖 语料文件: ${corpusPath}（${bodies.length} 篇可用）`);
  } else {
    // 兜底：查 knowledge_entries（ingest-wechat-corpus.ts 入库的公众号历史文章）
    console.log(`语料文件不存在（${corpusPath}），改查 DB knowledge_entries…`);
    const { db, closePool } = await import("../models/db.js");
    const { knowledgeEntries } = await import("../models/schema.js");
    const { and, eq, like } = await import("drizzle-orm");
    const tenantId = arg("tenant") || SYSTEM_RECOMMENDATION_TENANT_ID;
    const rows = await db
      .select({ title: knowledgeEntries.title, content: knowledgeEntries.content })
      .from(knowledgeEntries)
      .where(and(
        eq(knowledgeEntries.tenantId, tenantId),
        eq(knowledgeEntries.category, "content_format"),
        like(knowledgeEntries.source, "wechat_history:%"),
      ))
      .limit(500);
    bodies = rows.map((r) => `${r.title}\n${r.content}`);
    console.log(`📖 DB 语料: ${bodies.length} 篇（tenant=${tenantId}）`);
    void closePool; // 主流程结束时统一关
  }

  // 随机抽样 ≤sampleN 篇，各取开头 150 字（标题+正文头部，钩子都在这）
  for (let i = bodies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bodies[i], bodies[j]] = [bodies[j], bodies[i]];
  }
  return bodies.slice(0, sampleN).map((b) => b.replace(/\s+/g, " ").trim().slice(0, 150));
}

async function main() {
  const sampleN = Math.min(Number(arg("sample") || 60), 60);
  const outPath = resolve(process.cwd(), arg("out") || "data/hook-patterns-learned.json");
  const tenantId = arg("tenant") || SYSTEM_RECOMMENDATION_TENANT_ID;

  const openings = await loadOpenings(sampleN);
  if (openings.length < 10) {
    console.error(`❌ 可用语料只有 ${openings.length} 篇（<10），提炼没有统计意义，退出。`);
    process.exitCode = 1;
    return;
  }
  console.log(`🔬 抽样 ${openings.length} 篇开头（各 150 字），LLM 聚类提炼中…`);

  const numbered = openings.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const resp = await chat({
    tenantId,
    userId: "system",
    conversationId: `extract-hooks-${Date.now()}`,
    skillType: "quality_check", // 聚类归纳属重逻辑场景
    message: `以下是 ${openings.length} 篇学术自媒体公众号文章的开头（各前150字）。请归纳这批文章实际在用的"开头钩子模式"，聚类成 6-10 个模式。

要求：
1. 模式必须真实来自这批语料的写法共性，不要发明语料里不存在的模式
2. 每个模式给出：name（4-6字模式名）、structure（一句话结构说明：第一句干什么、第二句干什么）、examples（从语料里挑或轻改 2 条最典型的例句，保留真人口吻）
3. 按语料中出现频率从高到低排序
4. 只输出 JSON 数组，不要解释：
[{"name":"…","structure":"…","examples":["…","…"]}]

语料开头列表：
${numbered}`,
  });

  const m = resp.content.match(/\[[\s\S]*\]/);
  if (!m) {
    console.error("❌ LLM 输出无 JSON 数组，原样输出前 500 字供排查：\n", resp.content.slice(0, 500));
    process.exitCode = 1;
    return;
  }
  const patterns = JSON.parse(m[0]) as HookPattern[];
  const valid = patterns.filter(
    (p) => p && typeof p.name === "string" && typeof p.structure === "string" && Array.isArray(p.examples)
  );
  if (valid.length < 4) {
    console.error(`❌ 有效模式只有 ${valid.length} 个（<4），不覆盖种子库，退出。`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(valid, null, 2), "utf-8");
  console.log(`✅ 提炼出 ${valid.length} 个钩子模式 → ${outPath}`);
  valid.forEach((p, i) => console.log(`  ${i + 1}. 【${p.name}】${p.structure}`));
  console.log("\n运行时 hook-patterns.ts 会自动合并该文件（学到的优先）。删除该文件即回退纯种子库。");
}

main()
  .then(async () => {
    try { const { closePool } = await import("../models/db.js"); await closePool(); } catch { /* 未连库场景 */ }
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (e) => {
    console.error("提炼异常:", e instanceof Error ? e.message : e);
    try { const { closePool } = await import("../models/db.js"); await closePool(); } catch { /* 忽略 */ }
    process.exit(1);
  });
