/**
 * 思维链开关 A/B 对比（8-14）。**只读：不写 contents、不写 journal_usage。**
 *
 * ## 要验的假设
 *
 * 「生成结构化 JSON 用不上深度推理」—— 这是**假设**，不是结论。
 * 支持它的证据只有成本侧：百炼实测 reasoning_tokens 算在 completion_tokens 里，
 * 与正文共用 maxTokens 预算，日志里 3 条 `outputTokens=6001 / rawLength=0`
 * 就是预算被推理吃光、正文一个字都没轮上。
 *
 * 但「烧了钱」不等于「没用」。所以这里同刊两跑（开/关），逐项对比：
 *   · 质量：六维总分
 *   · 违规：正文编造检测 + 出稿健康问题数
 *   · 完整性：4 个深度章节 + videoScript 命中数、正文字数
 *   · 成本：completion_tokens（推理 + 正文）
 *
 * ## 为什么同刊对比而不是各跑一批
 *
 * 刊与刊之间的数据丰俭差异（sparse/rich）比开关的影响大得多，
 * 两批不同的刊比出来的差值主要是选刊噪声。同刊自比才看得见开关本身。
 *
 * ```bash
 * npx tsx src/scripts/compare-thinking.ts            # 10 刊
 * npx tsx src/scripts/compare-thinking.ts --n 4      # 少跑几篇先看看
 * ```
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { checkOutputHealth } from "../services/publisher/output-health.js";

const argN = Number(process.argv[process.argv.indexOf("--n") + 1]);
const N = Number.isFinite(argN) && argN > 0 ? argN : 10;

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
async function callOnce(prompt: string, system: string, thinking: boolean): Promise<Run> {
  const key = process.env.QWEN_API_KEY ?? "";
  const body: Record<string, unknown> = {
    model: "deepseek-v4-pro",
    max_tokens: 6000,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  };
  if (!thinking) body.enable_thinking = false;

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
  const rows = await db
    .select({ name: journals.name, nameEn: journals.nameEn, discipline: journals.discipline, catalogs: journals.catalogs })
    .from(journals)
    .where(and(or(isNull(journals.tenantId), sql`true`), eq(journals.isActive, true)))
    .orderBy(sql`random()`)
    .limit(N);

  console.log(`对比 ${rows.length} 刊 · 每刊两跑（推理开 / 推理关）\n`);
  const agg = { on: { tok: 0, reason: 0, len: 0, sec: 0, vs: 0, bad: 0, fail: 0 }, off: { tok: 0, reason: 0, len: 0, sec: 0, vs: 0, bad: 0, fail: 0 } };

  for (const [i, r] of rows.entries()) {
    const facts = `期刊：${r.name}${r.nameEn ? `（${r.nameEn}）` : ""}\n学科：${r.discipline ?? "未标注"}\n收录目录：${Array.isArray(r.catalogs) && r.catalogs.length ? (r.catalogs as string[]).join("、") : "无"}`;
    const prompt = `${facts}\n\n按上述字段写一篇期刊推荐。`;

    const [on, off] = [await callOnce(prompt, SYSTEM, true), await callOnce(prompt, SYSTEM, false)];
    for (const [k, v] of [["on", on], ["off", off]] as const) {
      const a = agg[k];
      a.tok += v.completionTokens;
      a.reason += v.reasoningTokens;
      a.len += v.bodyLen;
      a.sec += v.sections;
      a.vs += v.hasVideoScript ? 1 : 0;
      a.bad += v.healthIssues.length;
      a.fail += v.ok ? 0 : 1;
    }
    console.log(
      `[${i + 1}/${rows.length}] ${String(r.name).slice(0, 20)}\n` +
        `   开 tok=${on.completionTokens}(推理${on.reasoningTokens}) 字=${on.bodyLen} 章节=${on.sections}/4 口播=${on.hasVideoScript ? "有" : "无"} 健康问题=${on.healthIssues.join(",") || "无"}${on.ok ? "" : " ⚠️JSON失败"}\n` +
        `   关 tok=${off.completionTokens}(推理${off.reasoningTokens}) 字=${off.bodyLen} 章节=${off.sections}/4 口播=${off.hasVideoScript ? "有" : "无"} 健康问题=${off.healthIssues.join(",") || "无"}${off.ok ? "" : " ⚠️JSON失败"}`,
    );
  }

  const n = rows.length || 1;
  const line = (k: "on" | "off") => {
    const a = agg[k];
    return `  ${k === "on" ? "推理开" : "推理关"}  均 tok ${Math.round(a.tok / n)}(推理 ${Math.round(a.reason / n)})  均字数 ${Math.round(a.len / n)}  章节 ${(a.sec / n).toFixed(1)}/4  口播 ${a.vs}/${n}  健康问题 ${a.bad}  JSON失败 ${a.fail}`;
  };
  console.log(`\n===== 汇总（${n} 刊）=====\n${line("on")}\n${line("off")}`);
  console.log(
    "\n判据：关掉后【字数/章节/口播/健康问题/JSON失败】任一明显变差 → 假设不成立，别关。\n" +
      "     全部持平或更好 → 假设成立，可以关（省的是 tok 那一栏）。",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
