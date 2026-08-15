/**
 * 推理参数 A/B 对比（8-14 起）。**只读：不写 contents、不写 journal_usage。**
 *
 * ## 用法
 *
 * ```bash
 * npx tsx src/scripts/compare-thinking.ts --variant no-thinking   # 现状 vs 完全关闭推理
 * npx tsx src/scripts/compare-thinking.ts --variant effort-low    # 现状 vs reasoning_effort=low
 * ```
 *
 * ## 🔴 判据先注册，再跑
 *
 * 判据写死在本文件里（`CRITERIA`），脚本开跑前先把它们打印出来。
 * 事后挑一个好看的维度当结论，是这类对比最容易出的问题。
 *
 *   ① 字数落在 800-1200 目标区间（**关思维链就是栽在这条：889 → 585**）
 *   ② 质量持平：章节 / 口播 / 健康问题 / JSON 成功率，与现状差 < 5%
 *   ③ 截断率下降 —— 这是做这件事的**唯一动机**，它不降，①② 再好也白改
 *
 * 三条全过 → 可灰度全量；任何一条不过 → 停，转结构性方案（拆调用）。
 *
 * ## ⚠️ ③ 在随机 10 刊上测不出来，所以样本要定向
 *
 * 生产里撞顶是 3 次 / ~1752 篇 ≈ 0.17%，随机 10 刊的期望命中 0.017 条 ——
 * 两臂都会是 0/10，那不是"下降"，是没测。所以样本 = **日志里真撞过顶的那 2 本**
 * （计算机与教育 / 教育研究评论，各跑 REPEATS 次）+ 若干随机刊。
 * 悬崖是随机事件，重复跑才估得出频率。
 *
 * ## 为什么同刊对比
 *
 * 刊与刊的数据丰俭差异（sparse/rich）比参数影响大得多，
 * 两批不同的刊比出来的差值主要是选刊噪声。同刊自比才看得见参数本身。
 */
import { inArray, isNull, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { checkOutputHealth } from "../services/publisher/output-health.js";
import { env } from "../config/env.js";

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const argN = Number(arg("--n"));
const N = Number.isFinite(argN) && argN > 0 ? argN : 8;
const VARIANT = (arg("--variant") ?? "effort-low") as "no-thinking" | "effort-low";

/** 日志里真撞过 outputTokens=6001 的刊 —— ③ 号判据只能在这些刊上测 */
const CLIFF_JOURNALS = ["计算机与教育", "教育研究评论"];
/** 悬崖是随机事件, 单跑一次说明不了频率 */
const REPEATS = 5;
/** 撞顶判定线（maxTokens 6000, 实测撞顶值是 6001） */
const CLIFF_AT = 5900;

/** 🔴 判据先注册后跑 —— 跑之前打印, 事后不许换 */
const CRITERIA = [
  "① 字数：实验组均值落在 800-1200 区间内（关思维链栽在这条：889 → 585）",
  "② 质量：章节 / 口播 / 健康问题 / JSON 成功率，与现状差 < 5%",
  "③ 截断率：悬崖刊上撞顶比例下降 —— 唯一动机，不降则①②再好也白改",
] as const;

interface Run {
  ok: boolean;
  /** 可见正文长度（去 HTML/空白） */
  bodyLen: number;
  /** 4 个深度章节里有几个非空 */
  sections: number;
  hasVideoScript: boolean;
  healthIssues: string[];
  completionTokens: number;
  reasoningTokens: number;
  raw: string;
}

const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;

/** 直连 compatible-mode，绕开路由/熔断 —— 本脚本要比的是模型行为，不是链路行为 */
/** baseline=true 走现状（不加任何推理参数）；false 走实验组 */
async function callOnce(prompt: string, system: string, baseline: boolean): Promise<Run> {
  const key = process.env.QWEN_API_KEY ?? "";
  const body: Record<string, unknown> = {
    // 模型名走 env（红线 #3 的守卫: 业务代码不得硬编码模型名 —— 7-25 DeepSeek
    //   下线事故就是硬编码散落各处, 换模型时漏改一处就整条链路静默走废）
    model: env.DEEPSEEK_MODEL_CHAT,
    max_tokens: 6000,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  };
  if (!baseline) {
    if (VARIANT === "no-thinking") body.enable_thinking = false;
    else body.reasoning_effort = "low";
  }

  const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as any;
  const content = String(j?.choices?.[0]?.message?.content ?? "");
  const usage = j?.usage ?? {};

  let parsed: Record<string, unknown> | null = null;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch {
    parsed = null;
  }

  const sectionKeys = ["ifHistoryAnalysis", "carRiskAnalysis", "scopeAndCitations", "submissionAdvice"];
  const bodyText = String(parsed?.recommendation ?? "");
  const health = checkOutputHealth({ title: String(parsed?.title ?? ""), body: bodyText });

  return {
    ok: parsed !== null,
    bodyLen: plain(bodyText),
    sections: sectionKeys.filter((k) => typeof parsed?.[k] === "string" && String(parsed[k]).trim().length > 0).length,
    hasVideoScript: typeof parsed?.videoScript === "string" && String(parsed.videoScript).trim().length > 0,
    healthIssues: (health.issues ?? []).map((i) => i.code),
    completionTokens: Number(usage.completion_tokens ?? 0),
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0),
    raw: content.slice(0, 200),
  };
}

const SYSTEM =
  "你是学术期刊推荐编辑。只输出一个 JSON 对象，第一个字符是 {，最后一个字符是 }，不要 markdown 围栏。\n" +
  "字段：title(标题)、openingHook(开头钩子2-3句)、recommendation(正文800-1200字)、" +
  "ifHistoryAnalysis、carRiskAnalysis、scopeAndCitations、submissionAdvice(各200-400字，没有依据就给 null)、" +
  "videoScript(250-350字口播稿)。\n" +
  "🔴 只写下面给出的事实，不得编造影响因子、分区、审稿周期、录用率。没有的数据就不写。";

async function main() {
  console.log(`【推理参数 A/B 对比】变体 = ${VARIANT}\n`);
  console.log("判据（先注册后跑，事后不许换）：");
  for (const c of CRITERIA) console.log("  " + c);
  console.log();

  const cliffRows = await db
    .select({ name: journals.name, nameEn: journals.nameEn, discipline: journals.disciplineCode, catalogs: journals.catalogs })
    .from(journals)
    .where(inArray(journals.name, CLIFF_JOURNALS));
  const randomRows = await db
    .select({ name: journals.name, nameEn: journals.nameEn, discipline: journals.disciplineCode, catalogs: journals.catalogs })
    .from(journals)
    .where(isNull(journals.tenantId))
    .orderBy(sql`random()`)
    .limit(N);

  console.log(`样本：悬崖刊 ${cliffRows.length} 本 × ${REPEATS} 次 + 随机 ${randomRows.length} 本 × 1 次，每次两臂\n`);

  type Agg = { n: number; tok: number; reason: number; len: number; sec: number; vs: number; bad: number; fail: number; cliff: number };
  const zero = (): Agg => ({ n: 0, tok: 0, reason: 0, len: 0, sec: 0, vs: 0, bad: 0, fail: 0, cliff: 0 });
  const all = { base: zero(), exp: zero() };
  const cliffOnly = { base: zero(), exp: zero() };
  const maxReason = { base: 0, exp: 0 };

  const runOne = async (r: typeof randomRows[number], tag: string, isCliff: boolean) => {
    const facts = `期刊：${r.name}${r.nameEn ? `（${r.nameEn}）` : ""}\n学科：${r.discipline ?? "未标注"}\n收录目录：${Array.isArray(r.catalogs) && r.catalogs.length ? (r.catalogs as string[]).join("、") : "无"}`;
    const prompt = `${facts}\n\n按上述字段写一篇期刊推荐。`;
    const base = await callOnce(prompt, SYSTEM, true);
    const exp = await callOnce(prompt, SYSTEM, false);
    for (const [k, v] of [["base", base], ["exp", exp]] as const) {
      for (const a of isCliff ? [all[k], cliffOnly[k]] : [all[k]]) {
        a.n++; a.tok += v.completionTokens; a.reason += v.reasoningTokens; a.len += v.bodyLen;
        a.sec += v.sections; a.vs += v.hasVideoScript ? 1 : 0; a.bad += v.healthIssues.length;
        a.fail += v.ok ? 0 : 1; a.cliff += v.completionTokens >= CLIFF_AT ? 1 : 0;
      }
      maxReason[k] = Math.max(maxReason[k], v.reasoningTokens);
    }
    const fmt = (v: typeof base) => `tok=${v.completionTokens}(推理${v.reasoningTokens}) 字=${v.bodyLen} 章节=${v.sections}/4 口播=${v.hasVideoScript ? "有" : "无"}${v.completionTokens >= CLIFF_AT ? " 🔴撞顶" : ""}${v.ok ? "" : " ⚠️JSON失败"}`;
    console.log(`${tag} ${String(r.name).slice(0, 18)}\n   现状 ${fmt(base)}\n   实验 ${fmt(exp)}`);
  };

  for (const r of cliffRows) for (let i = 0; i < REPEATS; i++) await runOne(r, `[悬崖 ${i + 1}/${REPEATS}]`, true);
  for (const [i, r] of randomRows.entries()) await runOne(r, `[随机 ${i + 1}/${randomRows.length}]`, false);

  const avg = (a: Agg, k: keyof Agg) => (a.n ? Number(a[k]) / a.n : 0);
  const show = (label: string, a: Agg) =>
    `  ${label}  n=${a.n}  均tok ${Math.round(avg(a, "tok"))}(推理 ${Math.round(avg(a, "reason"))})  均字数 ${Math.round(avg(a, "len"))}  章节 ${avg(a, "sec").toFixed(1)}/4  口播 ${a.vs}/${a.n}  健康问题 ${a.bad}  JSON失败 ${a.fail}  撞顶 ${a.cliff}/${a.n}`;

  console.log(`\n===== 全样本 =====\n${show("现状", all.base)}\n${show("实验", all.exp)}`);
  console.log(`\n===== 仅悬崖刊（③ 号判据只看这里）=====\n${show("现状", cliffOnly.base)}\n${show("实验", cliffOnly.exp)}`);
  console.log(`\n推理量峰值：现状 ${maxReason.base} / 实验 ${maxReason.exp}（机制证据：上限压没压住）`);

  // ── 判据裁决（脚本自己判，不留给我事后解释）──────────────────────
  const expLen = avg(all.exp, "len");
  const c1 = expLen >= 800 && expLen <= 1200;
  const near = (a: number, b: number) => (b === 0 ? a === 0 : Math.abs(a - b) / Math.abs(b) < 0.05);
  const c2 =
    near(avg(all.exp, "sec"), avg(all.base, "sec")) &&
    near(all.exp.vs / (all.exp.n || 1), all.base.vs / (all.base.n || 1)) &&
    all.exp.bad <= all.base.bad &&
    all.exp.fail <= all.base.fail;
  const cliffBase = cliffOnly.base.n ? cliffOnly.base.cliff / cliffOnly.base.n : 0;
  const cliffExp = cliffOnly.exp.n ? cliffOnly.exp.cliff / cliffOnly.exp.n : 0;
  const c3measurable = cliffOnly.base.cliff > 0;
  const c3 = c3measurable && cliffExp < cliffBase;

  console.log("\n===== 判据裁决 =====");
  console.log(`  ① 字数 ${Math.round(expLen)} 落 800-1200 → ${c1 ? "过" : "不过"}`);
  console.log(`  ② 质量与现状差 <5% → ${c2 ? "过" : "不过"}`);
  console.log(
    c3measurable
      ? `  ③ 悬崖刊撞顶率 ${(cliffBase * 100).toFixed(0)}% → ${(cliffExp * 100).toFixed(0)}% → ${c3 ? "过" : "不过"}`
      : `  ③ 无法裁决 —— 现状臂在悬崖刊上一次都没撞顶（n=${cliffOnly.base.n}），没有可下降的基数。加大 REPEATS 再跑。`,
  );
  console.log(`\n结论：${c1 && c2 && c3 ? "三条全过 → 可灰度全量" : "有判据不过 → 停，转结构性方案（拆调用）"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
