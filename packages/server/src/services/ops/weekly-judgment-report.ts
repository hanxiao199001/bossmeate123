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
import { summarize, judge, ledgerSince, MIN_ADJUDICATED, type CheckerVerdict } from "./checker-ledger.js";
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
  /**
   * ④ 达标率 —— 8-20 加（老韩）。
   *
   * **必须两个数并排报，缺一个就会被读反**（红线 #20 的形态）：
   *
   *   达标率 = 达标量 / 产量         低 → **可能是对的**。80 分是高线，
   *                                  严格的闸本来就该筛掉大部分。
   *   进箱未达标率                   高 → **只可能是闸没接上**。已经决定要发的东西
   *                                  不达标，说明判据根本没参与这个决定。
   *
   * 只报前者会得出"内容质量差"的错结论，而真问题在后者。
   * 周报此前只报产量（"本周文章 N 篇"），两个都没有。
   *
   * 8-20 实测（近 14 天）：产量 335 / 达标 49（15%）；
   * 进过草稿箱 103 篇，其中 86 篇（83.5%）未达标 —— 且 44 篇状态是 `needs_review`、
   * 18 篇是 `archived`。根因：**分发链路零处读六维**
   * （`services/publisher/` + `services/bulk-distribute/` grep `sixDim` 无命中）。
   *
   * `unqualified` 口径 = `sixDimPassed !== true`，**把"没跑过六维"也算未达标** ——
   * 无记录和明确不通过对"该不该发出去"是同一个答案，分开算会让 28 篇无记录的凭空消失。
   *
   * ═══ 🔴 8-23 口径更正：这两个数描述的是「被评分的那条线」，不是「我们发出去的内容」═══
   *
   * roundup（多刊盘点）**不走 batch-worker / quality-pipeline**，六维一次都没跑过：
   *
   * ```
   * roundup    28 篇   有六维分   0    进过分发  28  (100%)
   * 普通文章  317 篇   有六维分 312    进过分发 116  ( 37%)
   * ```
   *
   * 于是：
   *
   * ```
   * 「达标率 15~16.7%」        分母里没有 roundup
   * 「进箱未达标率 83.5%」      分母里同样没有
   * 分发内容里 roundup 占       28/(28+116) = 19.4%
   * ```
   *
   * **两个数都不是错的**，但它们回答的是「被评分的内容有多少达标」，
   * **不是**「我们发出去的内容有多少达标」。
   *
   * ▎ 近五分之一的产出，从来没有被任何质量标准检查过。
   *
   * 🔴 **下次有人拿这两个数当「我们内容的整体质量」用之前，先看这一段。**
   * 这是红线 #20 的经典形态：两个口径都对，混用时不会报错，只是答的是另一个问题。
   *
   * 处置进行中（8-23 起「先量不拦」）：roundup 开始落六维分但**不设闸**，
   * 3-5 夜后按预注册读法判断这把尺子对多刊合辑适不适用
   * （见 `scoring-rubric-experiment.ts` 文件头）。
   * 在那之前，`sixDimGateApplied: false` 标死了这批分没被闸拦过。
   */
  qualification: {
    scored: number;
    passed: number;
    passRate: number;
    distributed: number;
    distributedUnqualified: number;
  };
  /**
   * ④ 待审积压 —— 8-16 加。
   *
   * 这个数不是"运营慢"的指标，是**人在不在环里**的指标：
   * 8-10 起每天新增约 23 篇 needs_review，而 7 天内一条都没被清掉。
   * 持续上涨 = 人是瓶颈；稳定 = 正常水位。让它每周自己报，不用人去查。
   */
  backlog: { total: number; stale7d: number; addedThisWeek: number };
  /**
   * ④ 关键词分数分布 —— 8-18 加。
   *
   * 这是「常数判据检测」在**数据侧**的应用：8-17 发现关键词综合分有 1098/2938 = 37.4%
   * 并列满分，排序退化成插入序，选题因此坍缩到同一批词。修完回填过一次，
   * 但那只是**一张快照** —— 上游热度源随时可能再次饱和，或有人改权重把分布压平。
   * 让它每周自证：满分占比是否还 < 5%，TOP100 是不是仍被单一学科占据。
   */
  keywordScore: { total: number; atMaxRatio: number; topDisciplines: string; healthy: boolean };
  /**
   * ④ 测试基线失败数 —— 8-22 加。
   *
   * **只报数，不催。** 这是「让没人看的东西自己发声」的第三次应用
   * （前两次：列表体检、外部反馈倒计时）。
   *
   * 背景：CI 从 8-22 起改判「不许比基线更红」（`scripts/ci/baseline-gate.sh`），
   * 那道闸挡得住**新增**失败，但对**存量** 72 红完全无感 ——
   * 它们可以永远躺在 `known-failures.txt` 里，没有任何机制会提起它们。
   *
   * 所以让这个数每周出现一次。逐周看它：降 = 有人在清；持平 = 没人清（这不一定错，
   * 但它是个**决定**，应该被看见，而不是默默发生）。
   *
   * 🔴 不设阈值、不判健康与否、不写待办 —— 它不需要任何动作。
   *   一个天天报但没人能据此行动的告警，消耗的是整个仪表盘的信任（CC-待办 #1）。
   */
  testBaseline: { knownFailures: number | null };
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
  const since0 = await ledgerSince();
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

  // ④ 待审积压(见 backlog 字段注释)
  const [bk] = await db
    .select({
      total: sql<number>`count(*)::int`,
      stale7d: sql<number>`count(*) filter (where ${contents.createdAt} < now() - interval '7 days')::int`,
      addedThisWeek: sql<number>`count(*) filter (where ${contents.createdAt} >= now() - interval '7 days')::int`,
    })
    .from(contents)
    .where(and(eq(contents.type, "article"), eq(contents.status, "needs_review")));
  const backlog = { total: bk?.total ?? 0, stale7d: bk?.stale7d ?? 0, addedThisWeek: bk?.addedThisWeek ?? 0 };

  // ④ 达标率(见 qualification 字段注释)
  const scored = arts.filter((a) => (a.meta as Record<string, unknown> | null)?.sixDimScores != null).length;
  const passed = arts.filter((a) => (a.meta as Record<string, unknown> | null)?.sixDimPassed === true).length;
  // 进过分发的 = 在 content_publish_log 里留下过任一"已投递"状态的。
  // 用 exists 而非 join：一篇内容可能有多条日志(多号分发)，join 会把它数成多篇。
  const distRes = await db.execute(sql`
    SELECT count(*)::int AS distributed,
           count(*) FILTER (
             WHERE coalesce((c.metadata->>'sixDimPassed') = 'true', false) = false
           )::int AS unqualified
    FROM contents c
    WHERE c.type = 'article' AND c.created_at >= ${since}
      AND EXISTS (
        SELECT 1 FROM content_publish_log l
        WHERE l.content_id = c.id
          AND l.status IN ('draft_pushed', 'success', 'dispatched')
      )`);
  const distRow = ((distRes as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0];
  const distributed = Number(distRow?.distributed ?? 0);
  const qualification = {
    scored,
    passed,
    passRate: scored === 0 ? 0 : Math.round((passed / scored) * 1000) / 10,
    distributed,
    distributedUnqualified: Number(distRow?.unqualified ?? 0),
  };

  const health = {
    articles: arts.length,
    titleFallback,
    shortBody,
    truncated: trunc?.n ?? 0,
    note: arts.length === 0 ? "本周无出稿" : "",
  };

  // ④ 关键词分数分布(见 keywordScore 字段注释)
  let keywordScore = { total: 0, atMaxRatio: 0, topDisciplines: "(无数据)", healthy: true };
  try {
    const { scoreDistributionHealth } = await import("../agents/keyword-score.js");
    const rows = (await db.execute(sql`
      select composite_score s, category from keywords where status = 'active'`)).rows as Array<Record<string, unknown>>;
    const h = scoreDistributionHealth(rows.map((r) => Number(r.s ?? 0)));
    const top = (await db.execute(sql`
      select coalesce(category, '(未分类)') c, count(*)::int n from (
        select category from keywords where status = 'active' order by composite_score desc limit 100
      ) t group by 1 order by 2 desc limit 3`)).rows as Array<Record<string, unknown>>;
    keywordScore = {
      total: h.total,
      atMaxRatio: h.atMaxRatio,
      topDisciplines: top.map((t) => `${t.c} ${t.n}`).join(" · ") || "(无)",
      healthy: h.healthy,
    };
  } catch {
    /* 关键词表读不到不该拖垮整张周报 */
  }

  /**
   * 测试基线失败数（见 testBaseline 字段注释）。
   * 读文件而不是跑测试 —— 周报是只读汇报，不该在里面跑一遍全量单测。
   * 读不到就报 null（那一行整句不出现），**绝不写 0** —— 红线 #14：
   * "文件没读到"和"基线真的清空了"对读者是天差地别的两件事。
   */
  let testBaseline: { knownFailures: number | null } = { knownFailures: null };
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join, dirname } = await import("node:path");
    /**
     * 🔴 8-23：**向上找到为止，不数层数。**
     *
     * 第一版写死 `"../../../.."` —— 少算了一级（落在 `packages/` 而不是仓库根），
     * 于是永远读不到文件、永远报 null，实测周报里那一行**一次都没出现过**。
     * 而且 src 与 dist 的深度还不一样，数层数注定要再错一次。
     *
     * 它失败得是对的（报 null、整句不出现、绝不写 0，红线 #14）——
     * 但"失败形态正确"不等于"功能可用"，这两件事必须分开验（红线 #24）。
     */
    let dir = dirname(fileURLToPath(import.meta.url));
    let found: string | null = null;
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, ".github/known-failures.txt");
      if (existsSync(candidate)) { found = candidate; break; }
      const parent = dirname(dir);
      if (parent === dir) break;   // 到根了
      dir = parent;
    }
    if (found) {
      const raw = readFileSync(found, "utf8");
      // `# ` 开头的是元信息行（total_cases 等），与基线闸同口径，不计入条数
      testBaseline = { knownFailures: raw.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#")).length };
    }
  } catch {
    /* 读不到 → 保持 null, 那一行不出现 */
  }

  const todos = pickTodos({ checkers, annotated, health, backlog });
  const text = renderText({ weekOf, checkers, annotated, health, qualification, backlog, keywordScore, testBaseline, todos, ledgerSince: since0 });

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
    qualification,
    backlog,
    keywordScore,
    testBaseline,
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
  backlog?: { total: number; stale7d: number; addedThisWeek: number };
}): WeeklyTodo[] {
  const out: WeeklyTodo[] = [];

  // 1) 检查器有明确建议的（降级/升回）→ 需要老板拍板
  for (const c of input.checkers) {
    if (out.length >= MAX_TODOS) break;
    if (c.level === "suggest" && c.action) {
      out.push({
        what: `检查器「${c.checkerId}」：${c.message}`,
        // ⚠️ 不许写"你去设置页切开关" —— 检查器的主动/影子状态写在代码里
        //   （checker-registry.ts），后台没有这个页面。指一个不存在的按钮，
        //   比不给建议更糟：她会先找半天，然后再也不信这页。
        action: `把这一条念给老板，问要不要${c.action.replace(/^建议/, "")}。他说改，你把这行转给开发 —— 这个开关后台还没有页面，得开发来动。`,
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
        "他说提，把这行转给开发（这条线是代码里的常量，后台改不了）；他说不提，这条下周还会再出现，你不用管。",
      kind: "找老板拍板",
    });
  }

  // 2.5) 待审积压 —— 8-18 加。
  //   🔴 这是**产能与审核能力的差**，不是内容质量问题。
  //   实测积压 186 篇、其中 29 篇超 7 天没人动，而每天还在 +23。
  //   两条动作都在运营手里：多审一点，或少产一点。
  if (out.length < MAX_TODOS && input.backlog && input.backlog.stale7d > 0) {
    out.push({
      what:
        `待审积压 ${input.backlog.total} 篇，其中 ${input.backlog.stale7d} 篇超过 7 天没人动` +
        `（每天还在新增约 ${Math.round(input.backlog.addedThisWeek / 7)} 篇）`,
      action:
        "两条路选一条：① 每天在内容工坊审 10 条（积压会慢慢降）；" +
        "② 觉得审不过来，就在设置页把每日篇数调低 —— 这是产能和审核能力的差，不是内容不好。",
      kind: "点按钮",
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
  qualification: {
    scored: number;
    passed: number;
    passRate: number;
    distributed: number;
    distributedUnqualified: number;
  };
  backlog: { total: number; stale7d: number; addedThisWeek: number };
  /**
   * ④ 关键词分数分布 —— 8-18 加。
   *
   * 这是「常数判据检测」在**数据侧**的应用：8-17 发现关键词综合分有 1098/2938 = 37.4%
   * 并列满分，排序退化成插入序，选题因此坍缩到同一批词。修完回填过一次，
   * 但那只是**一张快照** —— 上游热度源随时可能再次饱和，或有人改权重把分布压平。
   * 让它每周自证：满分占比是否还 < 5%，TOP100 是不是仍被单一学科占据。
   */
  keywordScore: { total: number; atMaxRatio: number; topDisciplines: string; healthy: boolean };
  testBaseline: { knownFailures: number | null };
  todos: WeeklyTodo[];
  ledgerSince: string | null;
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
  // 🔴 两套口径必须标清楚, 否则读者会把「兜底标题 8」和「命中 2」当成打架的数。
  if (d.ledgerSince) {
    L.push(`  【口径】台账自 ${d.ledgerSince} 起记录；下面「出稿健康」是整周口径。`);
    L.push("        两边数字覆盖的时间不同，不能直接相减。");
  }
  if (d.checkers.length === 0) {
    L.push("  台账还没有数据 —— 表本周刚建，等出稿跑起来才会有行。");
  } else {
    // 🔴 零命中的闸**折叠成一行**。它们本周没话说，各占两行只会把
    //   真正有信息的行淹掉（8-14 首份真实周报：10 项里 8 项零命中，
    //   两条有命中的挤在一堆重复文案中间）。折叠不丢信息 —— 名字全列出来。
    const silent = d.checkers.filter((c) => c.hits === 0);
    const vocal = d.checkers.filter((c) => c.hits > 0);
    for (const c of vocal.slice(0, 12)) {
      const tag = c.mode === "shadow" ? "[影子]" : "";
      L.push(`  ${tag}${c.checkerId}  命中 ${c.hits} / 已裁决 ${c.adjudicated}`);
      L.push(`      ${c.message}`);
    }
    if (silent.length > 0) {
      L.push(
        `  另有 ${silent.length} 道闸本周零命中（安全闸本就该安静，不必然是坏事）：` +
          silent.map((c) => c.checkerId.replace(/^output_health\./, "")).join("、"),
      );
    }
    if (vocal.length === 0) L.push("  本周所有闸都没有命中。");
  }
  L.push("");

  // 🔴 达标率必须排在"出稿健康"之前 —— 出稿健康报的是次品率(兜底标题/过短/截断),
  //   那是"废稿有多少"; 达标率报的是"合格品有多少"。先看后者, 前者才有分母。
  L.push("■ 产量 / 达标量");
  const q = d.qualification;
  L.push(`  本周出稿 ${d.health.articles} 篇 ｜ 跑过六维 ${q.scored} 篇 ｜ 达标 ${q.passed} 篇（${q.passRate}%）`);
  // 🔴 只陈述事实与对照基准, 不写归因(红线 #13)。达标率低本身可能是对的 —— 见下一行的对照。
  L.push("        达标线 = 六维总分 ≥80 且每个维度 ≥6。这是高线，达标率低不一定是坏事。");
  if (q.distributed > 0) {
    const pct = Math.round((q.distributedUnqualified / q.distributed) * 1000) / 10;
    L.push(`  进入分发 ${q.distributed} 篇，其中未达标 ${q.distributedUnqualified} 篇（${pct}%）`);
    L.push("        ↑ 这个数才是要盯的：达标率低可以是闸严，进箱未达标率高只可能是闸没接上。");
  } else {
    // 零分发不等于正常 —— 分开报, 免得"0 篇未达标"被读成"全达标"
    L.push("  本周没有内容进入分发。");
  }
  L.push("");

  L.push("■ 出稿健康");
  L.push(`  本周文章 ${d.health.articles} 篇 ｜ 兜底标题 ${d.health.titleFallback} ｜ 正文过短 ${d.health.shortBody} ｜ 出稿闸拦下 ${d.health.truncated}`);
  // 🔴 只陈述事实与对照基准, 不写"这多半是因为运营没审"(红线 #13)
  L.push(
    `  待审积压 ${d.backlog.total} 篇（本周新增 ${d.backlog.addedThisWeek}，` +
      `其中 ${d.backlog.stale7d} 篇已超过 7 天还挂着）`,
  );
  // 🔴 解读说明**常驻**, 不挂在 stale7d>0 上 —— 它是"怎么读这个数", 不是告警。
  //   首周 stale7d 恰好为 0(积压从 8-10 起, 最老的卡在 7 天线上),
  //   挂条件的话最该看的那句话第一周就不出现了。
  L.push("        逐周看这个数：涨 = 没人在清，持平 = 正常水位。");
  // 关键词分数分布 —— 「常数判据检测」的数据侧版本，见 keywordScore 字段注释
  L.push(
    `  选题打分 ${d.keywordScore.total} 词 ｜ 并列满分占比 ${(d.keywordScore.atMaxRatio * 100).toFixed(1)}%` +
      `（>5% 就是打分失效）｜ TOP100 学科：${d.keywordScore.topDisciplines}` +
      (d.keywordScore.healthy ? "" : "  ← 分布已塌，选题会趋同"),
  );
  // 测试基线失败数 —— 只报数不催，见 testBaseline 字段注释
  if (d.testBaseline.knownFailures !== null) {
    L.push(`  测试基线失败 ${d.testBaseline.knownFailures} 条（逐周看：降 = 有人在清，持平 = 没人清）`);
  }
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
