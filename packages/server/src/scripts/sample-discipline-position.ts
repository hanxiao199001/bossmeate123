/**
 * 「学科定位」体裁样例脚本（A2 第 8 步，8-10）—— 出 10 篇 + 对比页给老板拍板。
 *
 * ## 🔴 三条硬纪律（写在最前面，因为违反任何一条都会污染生产）
 *
 * 1. **绝不 insert `journal_usage`**。roundup 那条分支是会写的；写了就消耗生产的
 *    15 天冷却，等于用样例把真实排产挤掉。
 * 2. **绝不 insert `contents`**。样例不进发布池。
 * 3. 输出写到 `packages/server/data/`（已在 .gitignore）。测试产物被 git 跟踪
 *    卡住 `deploy:smart` 这个项目出过两次事故。
 *
 * 本脚本**只读库 + 调 LLM + 写本地文件**，没有任何写库路径。
 *
 * ## 用法
 *
 *   在服务器 packages/server 下：npx tsx src/scripts/sample-discipline-position.ts
 *   取结果：ssh bossmate-boss cat <path> > local.html   （绝不往服务器 scp）
 *
 * ## 选刊两组，各服务一个目的
 *
 *   A 组 = 近 30 天用得最多的 5 本回头刊。它们多为 medium/rich，有现成的存量文章
 *          可做左右对比 —— 老板看的是**同一本刊，两种写法**。
 *   B 组 = 真 sparse 国内刊，其中至少 3 本同为教育口。刻意安排，用来在拍板前
 *          暴露「同学科多篇数字段雷同」这个最大落地风险。
 *
 * ## 三个拍板数字（脚本必须打印）
 *
 *   ① sparse 刊里本体裁的准入率（有多少本真能用）—— 全量扫，不调 LLM
 *   ② 10 篇的编造检测命中数（目标 0）
 *   ③ B 组同学科几篇的重复度
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents, journalUsage, journals } from "../models/schema.js";
import { classifyDataSupply } from "../services/journals/journal-data-supply.js";
import { buildCohortFromRow, cohortEligible, usableSlices } from "../services/journals/discipline-cohort.js";
import { pendingCatalogFacts } from "../services/journals/catalog-facts.js";
import { snapshotHealthy } from "../services/journals/catalog-snapshot.js";
import {
  generateDisciplinePosition,
  type DisciplinePositionResult,
} from "../services/content-engine/discipline-position-generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../../data/discipline-position-samples");

const A_GROUP_SIZE = 5;
const B_GROUP_SIZE = 5;

/**
 * 直接用 drizzle 推断的行类型。
 * 早先写成 `Record<string, unknown> & {id;name}`，索引签名会让它与 `JournalSupplyInput`
 * "没有共同属性"而编译不过 —— 而且真用起来会丢掉全部列的类型检查。
 */
type Row = typeof journals.$inferSelect;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 可见字数（剥标签） */
function plainLen(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
}

/** A 组：近 30 天 journal_usage 计数 TOP N。**只读**，不写这张表 */
async function pickGroupA(n: number): Promise<Row[]> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const top = await db
    .select({ journalId: journalUsage.journalId, c: sql<number>`count(*)::int` })
    .from(journalUsage)
    .where(gte(journalUsage.usedAt, since))
    .groupBy(journalUsage.journalId)
    .orderBy(desc(sql`count(*)`))
    .limit(n * 4);
  const out: Row[] = [];
  for (const t of top) {
    if (!t.journalId) continue;
    const [j] = await db.select().from(journals).where(eq(journals.id, t.journalId)).limit(1);
    if (j) out.push(j);
    if (out.length >= n) break;
  }
  return out;
}

/** 全部「有目录的国内刊」—— 准入率就在这个分母上算 */
async function allDomesticWithCatalog(): Promise<Row[]> {
  const rows = await db
    .select()
    .from(journals)
    .where(and(eq(journals.journalKind, "cn"), isNotNull(journals.catalogs)));
  return (rows ).filter((r) => classifyDataSupply(r).has.catalog);
}

/** B 组：真 sparse 国内刊，优先教育口，保证至少 3 本同一分类 */
function pickGroupB(pool: Row[], n: number): Row[] {
  const eligible = pool.filter((r) => {
    if (classifyDataSupply(r).level !== "sparse") return false;
    return cohortEligible(buildCohortFromRow(r)).ok;
  });
  // 按「目录自带分类」分桶，取最大的教育相关桶
  const byDiscipline = new Map<string, Row[]>();
  for (const r of eligible) {
    const s = usableSlices(buildCohortFromRow(r))[0];
    if (!s) continue;
    const k = s.disciplineOfThisJournal;
    byDiscipline.set(k, [...(byDiscipline.get(k) ?? []), r]);
  }
  const eduKey = [...byDiscipline.keys()].find((k) => k.includes("教育"));
  const edu = (eduKey ? byDiscipline.get(eduKey)! : []).slice(0, 3);
  const rest = eligible.filter((r) => !edu.includes(r)).slice(0, n - edu.length);
  return [...edu, ...rest];
}

/** 该刊最近一篇存量文章 —— 左栏的「现状文」。没有就留空，不伪造 */
async function latestExistingContent(journalId: string): Promise<{ title: string; body: string } | null> {
  const rows = await db
    .select({ title: contents.title, body: contents.body, metadata: contents.metadata })
    .from(contents)
    .where(and(eq(contents.type, "article"), sql`${contents.metadata}->>'journalId' = ${journalId}`))
    .orderBy(desc(contents.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r?.body) return null;
  return { title: r.title ?? "", body: r.body };
}

interface Sample {
  group: "A" | "B";
  journalId: string;
  journalName: string;
  supply: string;
  eligible: boolean;
  skipReason?: string;
  result?: DisciplinePositionResult;
  existing?: { title: string; body: string } | null;
}

async function main() {
  const health = snapshotHealthy();
  if (!health.ok) {
    console.error("❌ 目录快照不完整，拒绝生成：", health.errors);
    process.exit(1);
  }
  console.log("📦 目录快照 OK ｜ 未审校的目录常量：", pendingCatalogFacts().join(", ") || "（无）");

  // ── 拍板数字 ①：准入率（全量扫，零 LLM 调用）
  const pool = await allDomesticWithCatalog();
  const sparse = pool.filter((r) => classifyDataSupply(r).level === "sparse");
  const skipCounts = new Map<string, number>();
  let pass = 0;
  for (const r of sparse) {
    const g = cohortEligible(buildCohortFromRow(r));
    if (g.ok) pass++;
    else skipCounts.set(g.reason!, (skipCounts.get(g.reason!) ?? 0) + 1);
  }
  const admitRate = sparse.length > 0 ? ((pass / sparse.length) * 100).toFixed(1) : "0";
  console.log(`\n【拍板数字①】sparse 国内刊准入率：${pass}/${sparse.length} = ${admitRate}%`);
  for (const [k, v] of [...skipCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    不通过 ${k}: ${v} 本`);
  }

  // ── 选刊
  const groupA = await pickGroupA(A_GROUP_SIZE);
  const groupB = pickGroupB(pool, B_GROUP_SIZE);
  console.log(`\n选刊 A 组（回头刊 TOP${A_GROUP_SIZE}）：${groupA.map((r) => r.name).join("、")}`);
  console.log(`选刊 B 组（真 sparse 国内刊）：${groupB.map((r) => r.name).join("、")}`);

  const samples: Sample[] = [];
  let seed = 0;
  for (const [group, rows] of [
    ["A", groupA],
    ["B", groupB],
  ] as const) {
    for (const row of rows) {
      const supply = classifyDataSupply(row).level;
      const gate = cohortEligible(buildCohortFromRow(row));
      if (!gate.ok) {
        console.log(`  ⏭  ${row.name}（${supply}）跳过：${gate.reason}`);
        samples.push({
          group,
          journalId: row.id,
          journalName: row.name,
          supply,
          eligible: false,
          skipReason: gate.reason,
        });
        continue;
      }
      process.stdout.write(`  ▶ ${row.name}（${supply}）生成中…`);
      const res = await generateDisciplinePosition({
        row,
        variantSeed: seed++,
        rotationScope: `sample-discipline-position-${group}`,
      });
      if (!res.ok) {
        console.log(` ❌ ${res.reason} ${res.detail ?? ""}`);
        samples.push({ group, journalId: row.id, journalName: row.name, supply, eligible: true, skipReason: res.reason });
        continue;
      }
      const v = res.checks.numberViolations.length;
      const f = res.checks.fabrication.length;
      const h = res.checks.health.issues.length;
      console.log(` ✅ ${plainLen(res.html)} 字 ｜ 数字违规 ${v} ｜ 编造 ${f} ｜ health ${h}`);
      samples.push({
        group,
        journalId: row.id,
        journalName: row.name,
        supply,
        eligible: true,
        result: res,
        existing: await latestExistingContent(row.id),
      });
    }
  }

  const done = samples.filter((s) => s.result);

  // ── 拍板数字 ②：编造命中数
  const totalViolations = done.reduce(
    (a, s) => a + s.result!.checks.numberViolations.length + s.result!.checks.fabrication.length,
    0,
  );
  console.log(`\n【拍板数字②】${done.length} 篇合计 编造/数字违规命中：${totalViolations} 处（目标 0）`);

  // ── 拍板数字 ③：B 组同学科重复度
  const bEdu = done.filter(
    (s) => s.group === "B" && usableSlices(s.result!.cohort)[0]?.disciplineOfThisJournal.includes("教育"),
  );
  let dupNote = "B 组不足 2 篇同学科，无法评估";
  if (bEdu.length >= 2) {
    const sentSets = bEdu.map(
      (s) =>
        new Set(
          s
            .result!.html.replace(/<[^>]+>/g, "\n")
            .split(/[\n。]/)
            .map((x) => x.trim())
            .filter((x) => x.length > 12),
        ),
    );
    let shared = 0;
    let total = 0;
    for (let i = 0; i < sentSets.length; i++) {
      for (let j = i + 1; j < sentSets.length; j++) {
        const inter = [...sentSets[i]!].filter((x) => sentSets[j]!.has(x)).length;
        shared += inter;
        total += Math.min(sentSets[i]!.size, sentSets[j]!.size);
      }
    }
    dupNote = `同为教育口的 ${bEdu.length} 篇，两两之间完全相同的句子占比 ${
      total > 0 ? ((shared / total) * 100).toFixed(1) : "0"
    }%（共 ${shared} 句）`;
  }
  console.log(`【拍板数字③】${dupNote}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUT_DIR, "samples.json"),
    JSON.stringify(
      samples.map((s) => ({
        ...s,
        result: s.result
          ? {
              title: s.result.title,
              recipe: s.result.recipe,
              metadata: s.result.metadata,
              checks: s.result.checks,
              llm: s.result.llm,
              plainLen: plainLen(s.result.html),
            }
          : undefined,
        existing: undefined,
      })),
      null,
      2,
    ),
    "utf-8",
  );

  writeFileSync(
    resolve(OUT_DIR, "compare.html"),
    buildComparePage(samples, { admitRate, pass, sparseTotal: sparse.length, skipCounts, totalViolations, dupNote }),
    "utf-8",
  );
  console.log(`\n📄 已写出：${OUT_DIR}/compare.html`);
  console.log(`   取回：ssh bossmate-boss cat ${OUT_DIR}/compare.html > compare.html`);
  process.exit(0);
}

function buildComparePage(
  samples: Sample[],
  stat: {
    admitRate: string;
    pass: number;
    sparseTotal: number;
    skipCounts: Map<string, number>;
    totalViolations: number;
    dupNote: string;
  },
): string {
  const done = samples.filter((s) => s.result);
  const rows = done
    .map((s) => {
      const r = s.result!;
      const d = r.checks.density;
      const len = plainLen(r.html);
      return `<tr>
      <td>${esc(s.group)}</td><td>${esc(s.journalName)}</td><td>${esc(s.supply)}</td>
      <td>${len}</td><td>${d.factsAvailable}</td><td>${d.factsCited}</td>
      <td>${r.metadata.cohortSlices ? (r.metadata.cohortSlices as unknown[]).length : 0}</td>
      <td>${((r.checks.numberViolations.length / Math.max(1, len)) * 100).toFixed(2)}</td>
      <td class="${r.checks.numberViolations.length + r.checks.fabrication.length > 0 ? "bad" : "good"}">${
        r.checks.numberViolations.length + r.checks.fabrication.length
      }</td>
      <td class="${r.checks.health.issues.length > 0 ? "bad" : "good"}">${r.checks.health.issues.length}</td>
    </tr>`;
    })
    .join("");

  const skipRows = samples
    .filter((s) => !s.result)
    .map((s) => `<tr><td>${esc(s.group)}</td><td>${esc(s.journalName)}</td><td colspan="8">跳过：${esc(s.skipReason)}</td></tr>`)
    .join("");

  const blocks = done
    .map((s) => {
      const r = s.result!;
      const evid = [
        ...r.checks.numberViolations.map((v) => `【${v.kind}】命中「${v.matched}」 ← ${v.sentence}`),
        ...r.checks.fabrication.map((f) => `【编造】${typeof f === "string" ? f : JSON.stringify(f)}`),
        ...r.checks.health.issues.map((i) => `【health/${i.code}】${i.detail}`),
      ];
      const white = [
        ...new Set(
          (r.metadata.cohortSlices as Array<Record<string, unknown>> | undefined)?.flatMap((x) => [
            String(x.countInDiscipline),
            String(x.countInCatalogTotal),
            String(x.shareOfCatalogPct),
          ]) ?? [],
        ),
      ];
      return `<section class="pair">
      <h2>${esc(s.group)} 组 ｜ ${esc(s.journalName)} <small>（${esc(s.supply)} ｜ 钩子:${esc(
        r.recipe.hook,
      )}）</small></h2>
      <div class="cols">
        <div><h3>现状（存量文章）</h3>${
          s.existing
            ? `<iframe srcdoc="${esc(s.existing.body)}"></iframe>`
            : `<p class="none">该刊没有存量文章可对比</p>`
        }</div>
        <div><h3>新体裁「学科定位」</h3><p class="t">${esc(r.title)}</p><iframe srcdoc="${esc(
          r.html,
        )}"></iframe></div>
      </div>
      <details><summary>证据区（命中 ${evid.length} 条 ｜ 本篇数字白名单：${esc(white.join("、"))}）</summary>
        <pre>${esc(evid.join("\n") || "（零命中）")}</pre></details>
    </section>`;
    })
    .join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>「学科定位」体裁样例对比</title>
<style>
body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;padding:24px;background:#f5f6f7;color:#222;line-height:1.7}
.banner{background:#fff3cd;border:1px solid #ffe08a;padding:14px 16px;border-radius:6px;margin-bottom:20px;font-size:15px}
table{border-collapse:collapse;width:100%;background:#fff;font-size:14px;margin-bottom:24px}
th,td{border:1px solid #e6e6e6;padding:7px 9px;text-align:center}
th{background:#fafafa}
.good{color:#2e7d32;font-weight:600}.bad{color:#c62828;font-weight:600}
.pair{background:#fff;border:1px solid #e6e6e6;border-radius:6px;padding:16px;margin-bottom:22px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
iframe{width:100%;height:520px;border:1px solid #eee;background:#fff}
.none{color:#999;font-size:14px;padding:24px;text-align:center;border:1px dashed #ddd}
.t{font-weight:600;font-size:16px;margin:6px 0}
pre{white-space:pre-wrap;font-size:13px;background:#fafafa;padding:10px;border-radius:4px}
h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;color:#666;margin:0 0 8px}
small{font-weight:400;color:#888;font-size:13px}
.stat{background:#fff;border:1px solid #e6e6e6;border-radius:6px;padding:14px 16px;margin-bottom:20px;font-size:15px}
</style></head><body>
<div class="banner">
  <b>未写库 · 未注册模板 · 未进任何轮换 · 拍板前零上线</b><br>
  目录快照：CSSCI/CSSCI扩展/CSCD 2023-2024 版，北大核心 2023 版。<br>
  ⚠️ 「目录是什么/怎么查证」这一章<b>刻意缺席</b> —— 四个目录的编制机构与官方查证入口
  尚未人工审校（<code>catalog-facts.ts</code> 全部 <code>reviewed:false</code>），
  不确认就不写，绝不由模型猜一个机构名或网址。
</div>
<div class="stat">
  <b>拍板数字①</b> sparse 国内刊准入率：${stat.pass}/${stat.sparseTotal} = <b>${stat.admitRate}%</b>
  ${[...stat.skipCounts].map(([k, v]) => `<br>　　不通过 ${esc(k)}：${v} 本`).join("")}<br><br>
  <b>拍板数字②</b> ${done.length} 篇合计编造/数字违规：<b class="${
    stat.totalViolations > 0 ? "bad" : "good"
  }">${stat.totalViolations}</b> 处（目标 0）<br><br>
  <b>拍板数字③</b> ${esc(stat.dupNote)}
</div>
<table><thead><tr>
<th>组</th><th>期刊</th><th>供给</th><th>字数</th><th>factsAvailable</th><th>factsCited</th>
<th>目录切片</th><th>违规/百字</th><th>编造命中</th><th>health</th>
</tr></thead><tbody>${rows}${skipRows}</tbody></table>
${blocks}
</body></html>`;
}

main().catch((err) => {
  console.error("脚本失败：", err);
  process.exit(1);
});
