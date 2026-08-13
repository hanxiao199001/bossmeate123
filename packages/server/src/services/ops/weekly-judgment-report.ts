/**
 * 判断层周报（8-14 方法论移植 Phase 2）—— 把人肉归因变成 cron。
 *
 * ## 这一页写给谁
 *
 * 写给**运营**（研小二），不是写给开发。所以：
 *   · ⑤ 待办建议是整页的**目的**，其余四段是**证据**
 *   · 每条建议必须是运营做得到的动作（点按钮 / 找老板拍 / 提工单），
 *     不能是「改代码」「调阈值」这种她做不了的事
 *   · 验收标准只有一条：**研小二能不能不问任何人就照着做**
 *
 * ## 🔴 第一份周报大概率满屏「台账未成熟，暂不评价」
 *
 * 这是**正确的**，不是尴尬的。台账要攒够人工裁决才有资格下结论，
 * 而 Phase 3 的反馈入口还没上。**不许用推测填空** ——
 * 诚实的「数据不够」比好看的假结论值钱。这条原则印在页脚，
 * 因为它是这整套东西能被信任的前提。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, opsIncidents, goldenSetAnnotations } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { summarize, judge, MIN_ADJUDICATED, type CheckerVerdict } from "./checker-ledger.js";
import { getChecker } from "./checker-registry.js";
import { bjDateString, truncateForWecom } from "./daily-briefing.js";

/** 运营做得到的动作类型 —— 写建议时对照，写不出其中之一就说明这条不该进 ⑤ */
export type OperatorAction =
  /** 在后台点一下（配置页开关 / 重跑按钮 / 审稿） */
  | "点按钮"
  /** 需要老板决策 */
  | "找老板拍板"
  /** 需要开发介入 */
  | "提工单给开发";

export interface WeeklyTodo {
  /** 一句话说清是什么问题 */
  what: string;
  /** 具体动作，写到"照着做"的粒度 */
  action: string;
  kind: OperatorAction;
}

export interface WeeklyReport {
  weekOf: string;
  /** ① 检查器台账 */
  checkers: Array<CheckerVerdict & { guards: string; mode: string; hits: number; adjudicated: number }>;
  /** ② 系统分 vs 人工标注 */
  scoreAgreement: { annotated: number; note: string };
  /** ③ 影子模式一致率 */
  shadow: { note: string };
  /** ④ 内容健康摘要 */
  health: { articles: number; titleFallback: number; shortBody: number; truncated: number; note: string };
  /** ⑤ 待办建议 —— 整页的目的，最多 3 条 */
  todos: WeeklyTodo[];
  text: string;
}

const MAX_TODOS = 3;

/** 页脚。**不是装饰** —— 它是这页能被信任的前提，见文件头 */
const FOOTER =
  "—————\n" +
  "本页只报有数据支撑的结论。写着「台账未成熟」的项目是**还没攒够人工裁决**，\n" +
  "不是没问题也不是有问题 —— 诚实的「数据不够」比好看的假结论值钱。";

export async function buildWeeklyReport(now: Date = new Date()): Promise<WeeklyReport> {
  const weekOf = bjDateString(now);
  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  // ① 检查器台账
  const stats = await summarize(4);
  const checkers = stats
    .map((s) => {
      const def = getChecker(s.checkerId);
      return {
        ...judge(s),
        guards: def?.guards ?? "(未注册)",
        mode: def?.mode ?? "unknown",
        hits: s.hits,
        adjudicated: s.adjudicated,
      };
    })
    .sort((a, b) => b.hits - a.hits);

  // ② 系统分 vs 人工标注
  const [ann] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(goldenSetAnnotations)
    .where(gte(goldenSetAnnotations.createdAt, since));
  const annotated = ann?.n ?? 0;

  // ④ 内容健康
  const arts = await db
    .select({ meta: contents.metadata, body: contents.body, status: contents.status })
    .from(contents)
    .where(and(eq(contents.type, "article"), gte(contents.createdAt, since)));
  const plainLen = (b: string | null) => String(b ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
  const titleFallback = arts.filter((a) => (a.meta as Record<string, unknown> | null)?.titleFallback === true).length;
  const shortBody = arts.filter((a) => {
    const l = plainLen(a.body);
    return l > 0 && l < 800;
  }).length;
  const [trunc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opsIncidents)
    .where(and(gte(opsIncidents.createdAt, since), sql`${opsIncidents.kind} = 'output_unhealthy'`));

  const health = {
    articles: arts.length,
    titleFallback,
    shortBody,
    truncated: trunc?.n ?? 0,
    note: arts.length === 0 ? "本周无出稿" : "",
  };

  const todos = pickTodos({ checkers, annotated, health });
  const text = renderText({ weekOf, checkers, annotated, health, todos });

  return {
    weekOf,
    checkers,
    scoreAgreement: {
      annotated,
      note:
        annotated === 0
          ? "本周无人工标注 —— 一致率无从算起（需要老板/运营在 Golden Set 里标几条）"
          : `本周人工标注 ${annotated} 条`,
    },
    shadow: { note: "影子放行一致率待 Phase 3 的裁决入口上线后才有输入" },
    health,
    todos,
    text,
  };
}

/**
 * ⑤ 待办建议。**最多 3 条，每条必须能让运营照着做。**
 *
 * 刻意保守：宁可少给一条，也不给一条她看不懂或做不了的。
 * 一页周报如果有一条建议是「调整 body_too_short 阈值」，
 * 那这页就不是写给运营的了。
 */
export function pickTodos(input: {
  checkers: Array<CheckerVerdict & { hits: number; adjudicated: number }>;
  annotated: number;
  health: { articles: number; titleFallback: number; shortBody: number; truncated: number };
}): WeeklyTodo[] {
  const out: WeeklyTodo[] = [];

  // 1) 检查器有明确建议的（降级/升回）→ 需要老板拍板
  for (const c of input.checkers) {
    if (out.length >= MAX_TODOS) break;
    if (c.level === "suggest" && c.action) {
      out.push({
        what: `检查器「${c.checkerId}」：${c.message}`,
        action: `把这一条念给老板，问要不要${c.action.replace(/^建议/, "")}。他说改，你在设置页把该项开关切一下即可。`,
        kind: "找老板拍板",
      });
    } else if (c.level === "warn") {
      out.push({
        what: `检查器「${c.checkerId}」几乎对所有内容都报警（${c.message}）`,
        action: "提工单给开发：这道检查可能写成了恒真条件，报警等于没报。附上本页这一行即可。",
        kind: "提工单给开发",
      });
    }
  }

  // 2) 正文过短占比 —— 这条不是运营能修的，但**是运营能推动的**：
  //    数据摆在这里，去问老板要不要提线（挂着的 CC-待办 #17）。
  //    🔴 只陈述事实与对照基准，不写"这多半是因为 X"（红线 #13）。
  const arts = input.health.articles;
  const shortPct = arts > 0 ? input.health.shortBody / arts : 0;
  if (out.length < MAX_TODOS && arts >= 30 && shortPct >= 0.2) {
    out.push({
      what:
        `本周 ${arts} 篇里有 ${input.health.shortBody} 篇正文不足 800 字（${Math.round(shortPct * 100)}%）；` +
        `系统当前只在不足 300 字时才拦，所以这些全部照常放行了`,
      action:
        "把这两个数念给老板，问「过短的线要不要从 300 字提到 800 字」。" +
        "他说提，你在设置页把出稿健康的正文长度改一下即可；他说不提，这条下周还会出现，不用管。",
      kind: "找老板拍板",
    });
  }

  // 3) 出稿健康：只报运营能处理的
  if (out.length < MAX_TODOS && input.health.titleFallback > 0) {
    out.push({
      what: `本周有 ${input.health.titleFallback} 篇文章的标题是系统兜底文案（AI 当时没返回内容）`,
      action: "在内容工坊按状态筛「待审」，看到标题异常的直接驳回重生成；数量超过 5 篇请提工单。",
      kind: "点按钮",
    });
  }

  // 🔴 解释类**垫底**：它不需要任何动作，不该占掉能做的事的位置。
  //   （首版把它排在第 2 位，MAX_TODOS=3 时会把「找老板拍板」挤出页面 ——
  //    一页只给 3 条的前提是这 3 条得是最该做的。）
  const immature = input.checkers.filter((c) => c.adjudicated < MIN_ADJUDICATED && c.hits > 0).length;
  if (out.length < MAX_TODOS && immature > 0) {
    out.push({
      what: `有 ${immature} 个检查器攒了命中但还没人裁决过，系统因此不敢下任何结论`,
      action:
        "等下周「抽样裁决」上线后，每周花 5 分钟点 10 条「这条拦对了/拦错了」。" +
        "在那之前无需动作 —— 这条只是让你知道为什么本页很多项写着「暂不评价」。",
      kind: "点按钮",
    });
  }

  return out.slice(0, MAX_TODOS);
}

function renderText(d: {
  weekOf: string;
  checkers: Array<CheckerVerdict & { guards: string; mode: string; hits: number; adjudicated: number }>;
  annotated: number;
  health: { articles: number; titleFallback: number; shortBody: number; truncated: number };
  todos: WeeklyTodo[];
}): string {
  const L: string[] = [];
  L.push(`【判断层体检】${d.weekOf}`);
  L.push("");

  // ⑤ 放最前 —— 运营每周只需读这一段，其余是证据
  L.push("■ 这周要你做的事");
  if (d.todos.length === 0) {
    L.push("  无 —— 本周没有需要你动手的事。");
  } else {
    d.todos.forEach((t, i) => {
      L.push(`  ${i + 1}. ${t.what}`);
      L.push(`     → 怎么做（${t.kind}）：${t.action}`);
    });
  }
  L.push("");

  L.push("■ 检查器台账（下面都是证据，不用逐条看）");
  if (d.checkers.length === 0) {
    L.push("  台账还没有数据 —— 表本周刚建，等出稿跑起来才会有行。");
  } else {
    for (const c of d.checkers.slice(0, 12)) {
      const tag = c.mode === "shadow" ? "[影子]" : "";
      L.push(`  ${tag}${c.checkerId}  命中 ${c.hits} / 已裁决 ${c.adjudicated}`);
      L.push(`      ${c.message}`);
    }
  }
  L.push("");

  L.push("■ 出稿健康");
  L.push(`  本周文章 ${d.health.articles} 篇 ｜ 兜底标题 ${d.health.titleFallback} ｜ 正文过短 ${d.health.shortBody} ｜ 出稿闸拦下 ${d.health.truncated}`);
  L.push("");

  L.push("■ 系统分 vs 人工");
  L.push(
    d.annotated === 0
      ? "  本周无人工标注，一致率无从算起。"
      : `  本周人工标注 ${d.annotated} 条（一致率趋势待 Golden Set 累积后给出）。`,
  );
  L.push("");
  L.push(FOOTER);
  return L.join("\n");
}

/** cron 入口。返回是否推送成功 */
export async function runWeeklyJudgmentReport(): Promise<{ weekOf: string; todos: number; pushed: boolean }> {
  const r = await buildWeeklyReport();
  let pushed = false;
  try {
    const { notifyStaffWithRetry } = await import("../work-wechat/kf-client.js");
    pushed = await notifyStaffWithRetry(truncateForWecom(r.text));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "weekly_report.push_failed");
  }
  logger.info({ weekOf: r.weekOf, todos: r.todos.length, checkers: r.checkers.length, pushed }, "weekly_report.done");
  return { weekOf: r.weekOf, todos: r.todos.length, pushed };
}
