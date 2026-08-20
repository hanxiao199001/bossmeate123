/**
 * 7-05 ⑤ 公众号草稿箱分发 — 每天早上给每个绑定公众号的账号推 top-N 候选进微信草稿箱,
 * 运营在公众号后台自选发布 (draft/add, 永不自动群发)。
 *
 * 与 PR-W6 auto-distribute 的分工:
 *   - auto-distribute: 租户开 autoDistribute 开关才跑, 走 bulk 队列, 目标是"当日推荐当日配对"。
 *   - draft-distributor: 面向"可发池"(近 7 天已过质检/人工采用/AI 采用、未发布、未推过),
 *     每号固定 top-N (env DRAFT_PUSH_PER_ACCOUNT), 强制 draft_only, 直接同步推 (量小, 每号≤N)。
 *
 * 复用 (红线 #11):
 *   - computeSmartPairs (smart-assign): 账号领域/国内外定位匹配 + 每号 dailyCap + 负载均衡。
 *   - publishToAccounts + WechatAdapter: draft/add + 封面 thumb_media_id + 图片上传素材库全链路。
 *   - content_publish_log: status='draft_pushed' 防重复推 (与 success/draft 同表同唯一索引)。
 *
 * 【一篇只推一个号 — 写死, 不做配置】
 *   同一篇文章绝不推给同租户多个公众号: 公众号平台有原创判重, 多号同文会被判"相互抄袭"
 *   连坐降权/封原创。computeSmartPairs 天生每篇只配一号(匹配分最高/负载最低者), 这里再用
 *   publish_log 按 contentId 排除任何"已推过/已发过"的文章做双保险。
 */
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, contentPublishLog, platformAccounts, tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { computeSmartPairs } from "./smart-assign.js";
import { publishToAccounts } from "./index.js";
import type { QualitySnapshot } from "./quality-verdict.js";

const POOL_WINDOW_DAYS = 7; // 可发池回看窗口: 太老的文章时效性差, 不推

/**
 * 可发池元素。8-20 把 `quality` 加进来 —— 质量判定在**建池时**已经算过一次
 * (下限闸要用), 带着走比在插入点重新读 metadata 好: 后者等于同一个判定算两遍,
 * 两处迟早漂移(同 fallback-messages.ts 注释里那个"检查器与被检查方各写一套判据"的失效)。
 */
interface PoolItem {
  id: string;
  title: string | null;
  quality: QualitySnapshot;
}

// ============ 7-27 可发池准入判据(模块级导出, 供单测锁行为) ============

/**
 * 红线类待审原因(信任事故/废稿) — 永不进草稿箱, 留人工。
 * 7-25 补 body_fabrication(下方硬闸自己打的标, 不进名单会被反复重拦); 7-27 补 output_unhealthy(同理)。
 * ⚠️ 7-27 把"未评上分"(旧名 sixdim_degraded)从这里**移出去了** —— 当天零产出的直接死因:
 *   质检 LLM 一超时, 20/25 条内容全被当"信任事故"剔除。"评分器挂了"≠"内容有问题"。
 */
// 7-28 (#6) 补 ai_fabricated_journal: 本篇关联到 LLM 编出来的影子刊(journals.data_source
//   = 'ai_fabricated')。这是**判据⑤**的硬红线 —— 反编造的另外三道判据校的都是"数字有没有源",
//   而影子刊的每个数字都能在那条假记录里找到"源", 三道闸全绿, 但整本刊不存在。
//   判定是确定性的(一个字段值, 零推断), 所以拦得起; 只有它进红线, "未核实"那档走队尾(见 TAIL_REASONS)。
// 8-20 补 six_dim_below_floor: 六维总分下限闸(distribute.minSixDimTotal)自己打的标。
//   同 body_fabrication / output_unhealthy 的道理 —— 不进名单会被反复重拦(白跑 + 日志刷屏)。
//   ⚠️ 它与上面那条"未评上分"的区分是本闸的要害: 这里进红线的是**评过分且分低**,
//   "评分器挂了"仍然走队尾(UNSCORED_REASONS), 绝不能因为加了这道闸又把 7-27 的零产出重演一遍。
export const RED_LINE_REASONS = ["title_data_fabricated", "title_body_inconsistent", "body_fabrication", "output_unhealthy", "ai_fabricated_journal", "six_dim_below_floor"];

/**
 * "没评上分"的 reason(不是"分低")。sixdim_degraded 是 7-27 前的旧名, 库里有存量, 一并识别。
 * 这类内容: ① 允许进草稿箱(草稿箱本身就是人工筛选台, 推进去还要人工挑+手动发, 不是自动群发)
 *          ② 但排在**队尾**, 只在有分的内容不够保底下限时才被取用
 *          ③ 仍要过所有确定性闸(出稿健康闸/正文编造闸)与发布期的合规+敏感词闸
 */
export const UNSCORED_REASONS = new Set(["quality_check_unavailable", "sixdim_degraded"]);

/**
 * 7-28 ②d: "闸没检查成"的 reason(batch-worker 的六维流水线异常 / 标题-正文一致性检查异常,
 * quality-check-v2 的红线规则检索或解析失败)。与 UNSCORED_REASONS 同一套处理逻辑:
 *   进池、排队尾、绝不当红线剔除 —— **"我们的检查器挂了" ≠ "内容有问题"**(7-27 血的教训)。
 * 单列一个常量而不是塞进 UNSCORED_REASONS: 那个集合的语义是"没评上分", 混进来会让日后
 * 读代码的人以为质检打了分。两者在排序时取并集(见 TAIL_REASONS)。
 */
export const GATE_UNAVAILABLE_REASONS = new Set(["quality_gate_unavailable"]);

/**
 * 7-28 (#6) 判据⑤ 的软档: 源刊未过分体系可信门槛(batch-worker 生成期打的标)。
 *
 * 缺口背景: `verification.ts` 的 isUnverifiedJournal 此前**发布链路一道闸都没读** ——
 *   batch-worker 标上的 `unverified_source_journal` 既不在红线(会剔除)也不在队尾(会降权),
 *   等于和完全核实过的内容平起平坐抢草稿箱名额。
 *
 * 为什么是队尾不是红线: 7-28 刚把国内刊改成"目录成员资格"判定, 而目录字段本身还有回填缺口;
 *   现在一刀切拦截 = 复刻 7-27 的零产出事故("我们的判定还不完备" ≠ "内容有问题")。
 *   排队尾既让核实过的内容优先, 又零停产风险。真·假刊那一档(ai_fabricated)走红线, 见上。
 */
export const UNVERIFIED_SOURCE_REASONS = new Set(["unverified_source_journal"]);

/** 排队尾的全部 reason: 没评上分 + 闸没检查成 + 源刊未核实。检查全过 + 源刊核实过的优先占名额。 */
export const TAIL_REASONS = new Set([
  ...UNSCORED_REASONS, ...GATE_UNAVAILABLE_REASONS, ...UNVERIFIED_SOURCE_REASONS,
]);

/** 纯函数: 该 status/待审原因能否进可发池(红线剔除, 其余包括"未评上分"放行) */
export function passesReasonGate(status: string | null, needsReviewReason: string | null | undefined): boolean {
  if (status === "generated") return true;
  return !needsReviewReason || !RED_LINE_REASONS.includes(needsReviewReason);
}

export interface DraftPushAccountReport {
  accountId: string;
  accountName: string;
  pushed: Array<{ contentId: string; title: string | null }>;
  errors: Array<{ contentId: string; error: string }>;
}

export interface DraftDistributeReport {
  tenantId: string;
  perAccount: DraftPushAccountReport[];
  poolSize: number;
  pushed: number;
  failed: number;
  skippedReason?: string;
  /** 7-14: 每号保底下限/上限, 供运营核对 */
  targetPerAccount?: number;
  capPerAccount?: number;
  /** 7-14: 两轮保底后仍未达下限的号 (内容不足信号, 明确报告不静默) */
  shortfalls?: Array<{ accountId: string; accountName: string | null; assigned: number; target: number }>;
  /** 7-28 ①c: 缺口自动补救的执行情况 (没触发时为 undefined) */
  remedy?: {
    attempted: boolean;
    /** 未触发的原因: disabled / no_shortfall / no_extra_content */
    skippedReason?: string;
    windowDays?: number;
    /** 补救轮实际推成功的条数 */
    pushed?: number;
    /** 补救前后的缺口号数 */
    shortfallsBefore?: number;
    shortfallsAfter?: number;
    error?: string;
  };
}

// ============ 7-28 ①c: 缺口补救 ============
//
// 决策记录(为什么是"自动补救"而不是"只告警"), 见交接报告:
//   触发条件 = 两轮保底跑完、**实际推送完成后**仍有号没到 target。
//   补救动作 = 只放宽【时效窗口】(7 天 → DRAFT_SHORTFALL_REMEDY_WINDOW_DAYS, 默认 21 天),
//              把三周内还没被推过的老内容拿出来补给缺口号。
//   刻意**不**放宽: 领域对口(相邻集之外宁缺, 7-14 既有产品决策)、六维质检、红线/编造/健康闸、
//              一篇只推一个号。—— 这一轮任务的另一半就是在堵 fail-open, 补救逻辑自己不能反向开口子。
//   防循环: ① 补救只跑一轮(内部函数无递归, 由 `remedy.attempted` 一次性标记);
//           ② 天然幂等 —— 主轮推成功的内容立刻落 content_publish_log, 补救轮 buildFreshPool
//              会把它们排除, 同一篇绝不会被推两次(重跑整个 cron 也一样);
//           ③ env 开关 DRAFT_SHORTFALL_REMEDY_ENABLED(默认 true), 出事一秒关掉;
//           ④ 补救本身抛错 → 落 draft_remedy_failed incident, 不影响主轮已推的结果。

/** 记一条告警(旁路, 绝不抛错 —— 告警挂了不能反过来搞挂分发) */
function reportDistIncident(input: {
  kind: string; severity: "error" | "warn"; tenantId: string; message: string; detail: Record<string, unknown>;
}): void {
  void import("../ops/incidents.js")
    .then((m) => m.recordIncident({
      kind: input.kind, severity: input.severity, tenantId: input.tenantId,
      message: input.message.slice(0, 500), detail: input.detail,
    }))
    .catch(() => { /* 告警旁路, 不阻塞分发 */ });
}

/**
 * 今日各号已落 content_publish_log 的条数(北京时间日切)。
 *
 * **这是"今天这个号收到几条内容"的唯一口径**, 缺口(未达保底)判定一律用它。
 * 与 smart-assign 的 preload 同一把尺子 —— 缺口判定必须和分配时用的尺子一致, 否则自相矛盾。
 *
 * ⚠️ 刻意**不按 status 过滤**: 一个号今天有没有拿到东西, 与它是被 draft-distribute 推的
 * (status=draft_pushed)还是被管理后台 bulk-distribute 推的(status=success)无关 ——
 * 都是"今天有内容进了这个号"。
 *
 * 7-29 导出给 ops/daily-briefing 复用。之前简报自己写了一份**只数 draft_pushed** 的统计,
 * 于是当天报"5 个公众号未达保底", 而分发器报 1/7 —— 实测那 4 个号各有 1 条
 * success/bulk_distribute 被简报漏数, 它们其实都 2/2 达标。后果不只是数字难看:
 * 运营会去处理 4 个根本没问题的号, 而真正坏掉的那个(appid 失效, 0 篇)淹没在里面。
 * 同一个判断两处各写各的 —— 与 7-28 分区判据那次同源, 不再重复。
 */
export async function countTodayAccountLoad(tenantId: string): Promise<Map<string, number>> {
  const bj = new Date(Date.now() + 8 * 3600_000); bj.setUTCHours(0, 0, 0, 0);
  const since = new Date(bj.getTime() - 8 * 3600_000);
  const rows = await db
    .select({ accountId: contentPublishLog.accountId, n: sql<string>`COUNT(*)` })
    .from(contentPublishLog)
    .where(and(eq(contentPublishLog.tenantId, tenantId), gte(contentPublishLog.createdAt, since)))
    .groupBy(contentPublishLog.accountId);
  return new Map(rows.map((r) => [r.accountId, Number(r.n)]));
}

/** 单租户跑一轮 */
export async function distributeDraftsForTenant(tenantId: string): Promise<DraftDistributeReport> {
  const report: DraftDistributeReport = { tenantId, perAccount: [], poolSize: 0, pushed: 0, failed: 0 };
  // 7-14: cap=每号上限(DRAFT_PUSH_PER_ACCOUNT); target=每号保底下限(DRAFT_TARGET_PER_ACCOUNT), 夹 ≤ cap。
  const perAccount = Math.max(1, Math.floor(env.DRAFT_PUSH_PER_ACCOUNT));
  /**
   * 🔴 8-20: 保底下限外化成 draft.targetPerAccount（默认仍读 env，行为不变）。
   *
   * 为什么它排在第一批被外化的「人工拍的数」里：**它从来没有和产能对齐过**。
   * 7 号 × 2 篇 = 14 篇/天，而实测达标产能约 1.6 篇/天 —— 差 8.75 倍。
   * 缺口不是靠拒发补的，是靠放低标准补的（实测进分发 103 篇里 86 篇不达标）。
   * 而「发 14 篇不达标 vs 2 篇达标哪个更好」**没有数据能回答**
   * （公众号阅读回流永远不可用，见 metrics/external-feedback-status.ts）。
   * 所以它是**生意判断**，得让人改得动，并在参数页上标明无数据依据。
   *
   * 下限改成 0 而不是 1：参数页写着「设 0 = 不保底」，这里若仍 Math.max(1,…)
   * 就是文案承诺了一件代码不做的事 —— 那类不一致比参数本身危险。
   */
  const { getParam: getRuntimeParam } = await import("../ops/runtime-params.js");
  const targetRaw = await getRuntimeParam<number>("draft.targetPerAccount");
  const target = Math.max(0, Math.min(perAccount, Math.floor(targetRaw)));
  report.targetPerAccount = target;
  report.capPerAccount = perAccount;

  // 1. 该租户启用中的公众号
  const accounts = await db
    .select({ id: platformAccounts.id, accountName: platformAccounts.accountName })
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.tenantId, tenantId),
      eq(platformAccounts.platform, "wechat"),
      eq(platformAccounts.status, "active"),
    ));
  if (accounts.length === 0) {
    report.skippedReason = "无启用中的公众号";
    return report;
  }

  // 2. 可发池构建 —— 7-28 抽成内部函数(唯一改动: 时效窗口 windowDays 变成参数)。
  //    补救轮(①c)要用同一套闸门、同一套排序、只把回看窗口放宽, 复制一份判据 = 必然漂移
  //    (fallback-messages.ts 注释里说的"检查器与被检查方各写一套判据"的经典失效)。
  const buildFreshPool = async (windowDays: number): Promise<PoolItem[]> => {
  // 可发池: 近 N 天、article
  //    7-13 修复"草稿箱饿死": 草稿箱本身就是运营人工筛选台(推进去还要人工挑+手动发, 非自动群发),
  //    所以"质检没过但不危险"的文章应带分数流进草稿箱让运营挑 —— 质检门不该在草稿箱前二次拦死。
  //    纳入: status=generated(已过/人工采用) + needs_review 里"六维偏低"这类质量问题;
  //    仍排除的红线类(标题数据造假 title_data_fabricated / 标题正文矛盾 title_body_inconsistent)——
  //    信任事故不进草稿箱, 永远留人工. 判据读 metadata.needsReviewReason。
  const since = new Date(Date.now() - windowDays * 24 * 3600_000);
  // 剔除: 红线两类(信任事故)
  // 7-25 补 body_fabrication: 它是下方硬闸自己打的标(:112), 却不在红线名单里 —— 被拦下标记过的内容
  //   下一轮又能进池、再被同一道闸拦一次(白跑 + 日志刷屏)。编造是数据造假红线, 与标题编造同级。
  // 7-27 补 output_unhealthy: 出稿健康闸打的标(:118 附近), 同 body_fabrication 的道理 ——
  //   被拦下标记过的废稿(占位文/截断/复读)下一轮又能进池、再被同一道闸拦一次(白跑 + 日志刷屏)。
  //   而且它是"这稿子根本不是内容"级别的问题, 比六维分低严重得多, 必须留人工。
  //
  // ⚠️ 7-27 把"未评上分"从红线里**移出来** —— 这是当天零产出的直接死因。
  //   原来 sixdim_degraded 在红线名单里, 于是质检 LLM 一超时, 20/25 条内容全被当"信任事故"剔除,
  //   整天零条进草稿箱, 而且**没有任何告警**。可"没评上分"和"标题造假"根本不是一回事:
  //   前者是我们自己的评分器挂了, 内容本身没有任何已知问题。
  //   新策略见 UNSCORED_REASONS: 不剔除, 但排到队尾 —— 有分的内容优先, 分不够时才用它顶上,
  //   既不静默停产, 也不让未经评分的内容抢掉正常内容的名额。
  //   (判据常量与纯函数已提到模块级导出: RED_LINE_REASONS / UNSCORED_REASONS / passesReasonGate)
  const rawPool = await db
    .select({ id: contents.id, title: contents.title, body: contents.body, status: contents.status, metadata: contents.metadata })
    .from(contents)
    .where(and(
      or(eq(contents.tenantId, tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      eq(contents.type, "article"),
      inArray(contents.status, ["generated", "needs_review"]),
      gte(contents.createdAt, since),
    ))
    .orderBy(desc(contents.createdAt))
    .limit(500);
  // needs_review 的文章: 只有非红线(六维偏低等质量问题)才放进草稿箱; 红线类剔除留人工
  const reasonPassed = rawPool.filter((c) =>
    passesReasonGate(c.status, (c.metadata as { needsReviewReason?: string } | null)?.needsReviewReason),
  ).slice(0, 300);

  // 7-21 发布前编造硬闸(确定性兜底): 纯国内刊正文出现 DB 无据的 IF/分区 → 不进草稿箱, 标 needs_review/body_fabrication。
  //   即使生成侧 prompt 漏网、六维分侥幸过线, 也发不出去。骑墙刊(含sci-core)豁免。复用 checkBodyFabrication。
  // 7-28 (#6): 改调 checkPublishJournalGate —— 同一次查库同时给出判据①(正文编造)与
  //   判据⑤(源刊可信度)。原来只调 checkBodyFabricationForPublish(它现在是这个函数的薄封装)。
  const { checkPublishJournalGate } = await import("../compliance/content-check.js");
  // 7-27 出稿健康闸(确定性兜底, 零 LLM/零 DB): 占位文/空/截断/复读 → 不进草稿箱, 标 needs_review/output_unhealthy。
  //   ⚠️ 关键: 这道闸放在**不看 status** 的位置 —— 上面的 reasonPassed 对 status=generated 是**无条件放行**的,
  //   7-27 那篇标题="抱歉，AI暂时无法响应，请稍后重试。"、六维 80 分、status=generated 的废稿正是从这个口子溜进草稿箱的。
  const { checkOutputHealth, OUTPUT_UNHEALTHY_REASON } = await import("./output-health.js");
  /**
   * 🔴 8-20 六维总分下限闸（老韩拍板 (c)：先只拦最烂的）。
   *
   * **为什么 7-13 的设计到今天才需要改**：那条注释（上面 :201）写着「草稿箱本身就是
   * 运营人工筛选台，质检门不该在草稿箱前二次拦死」—— 这个设计**依赖一个前提**：
   * 运营真的会在草稿箱里挑。8-16 起的实测把前提推翻了：`needs_review` 积压 186 篇、
   * 七天零消化。没人在筛的筛选台 = 内容直接流到读者面前。
   *
   * **所以本闸只拦最差的一档，不搬发布达标线**（80 分 + 每维 ≥6）。
   * 搬过来的话产量掉到约 1/5，而「少而精是不是更好」目前**没有数据能回答** ——
   * 那个判断要等 wechat_stats 接上、拿 quality_verdict 分组的效果数据才做得了。
   * 在能测量之前，只做无争议的部分。
   *
   * 阈值走配置表（红线 #22），改它不用发版；设 0 = 关闭本闸。
   */
  const { getParam } = await import("../ops/runtime-params.js");
  const minSixDimTotal = await getParam<number>("distribute.minSixDimTotal");
  const { resolveQualitySnapshot } = await import("./quality-verdict.js");
  const pool: PoolItem[] = [];
  const unscoredIds = new Set<string>(); // 7-27: 没评上分的, 排队尾(见 UNSCORED_REASONS)
  for (const c of reasonPassed) {
    const health = checkOutputHealth({ title: c.title, body: c.body, type: "article" });
    if (!health.healthy) {
      await db.update(contents)
        .set({ status: "needs_review", metadata: sql`COALESCE(${contents.metadata},'{}'::jsonb) || ${JSON.stringify({ needsReviewReason: OUTPUT_UNHEALTHY_REASON, outputHealth: { codes: health.codes, issues: health.issues } })}::jsonb`, updatedAt: new Date() })
        .where(eq(contents.id, c.id));
      logger.warn({ contentId: c.id, status: c.status, codes: health.codes, summary: health.summary }, "草稿分发硬闸: 出稿不健康(废稿特征), 剔除不进草稿箱, 转 needs_review");
      void import("../ops/incidents.js").then((m) => m.recordIncident({
        kind: "output_unhealthy",
        severity: "error",
        tenantId,
        message: `草稿分发拦下废稿(${health.codes.join("/")}): ${health.summary}`.slice(0, 500),
        detail: { contentId: c.id, stage: "draft_distribute", status: c.status, codes: health.codes, issues: health.issues },
      })).catch(() => { /* 告警旁路, 不阻塞分发 */ });
      continue;
    }
    // 🔴 8-20 六维总分下限闸(判据说明见上方 minSixDimTotal 处)。
    //   ⚠️ 只拦**评过分且分低**的。`unscored`(没跑过六维)**不拦** ——
    //   实测近 14 天有 29 篇进分发的内容从没跑过六维, 拦掉等于砍 28% 产量,
    //   而我们还不知道它们为什么没评上分。那是另一个洞, 要单独查, 不能用这道闸顺手掩盖掉
    //   (7-27 的教训原样重演: 把"我们的评分器挂了"当成"内容有问题"处理, 当天零产出)。
    const snap = resolveQualitySnapshot(c.metadata);
    if (minSixDimTotal > 0 && snap.sixDimTotal !== null && snap.sixDimTotal < minSixDimTotal) {
      await db.update(contents)
        .set({ status: "needs_review", metadata: sql`COALESCE(${contents.metadata},'{}'::jsonb) || ${JSON.stringify({ needsReviewReason: "six_dim_below_floor", sixDimFloor: minSixDimTotal })}::jsonb`, updatedAt: new Date() })
        .where(eq(contents.id, c.id));
      logger.warn({ contentId: c.id, sixDimTotal: snap.sixDimTotal, floor: minSixDimTotal }, "草稿分发硬闸: 六维总分低于下限, 剔除不进草稿箱, 转 needs_review");
      continue;
    }
    const cMeta = (c.metadata as { journalId?: string; journalIds?: string[] } | null) ?? {};
    const journalId = cMeta.journalId ?? null;
    // 7-25: 多刊盘点(roundup)的 metadata 带 journalIds 而非 journalId, 原来这里一律当"无期刊"放行。
    const journalIds = Array.isArray(cMeta.journalIds) ? cMeta.journalIds : null;
    const jGate = await checkPublishJournalGate({ body: c.body, journalId, journalIds });
    // 7-28 (#6) 判据⑤ 硬红线: 关联刊是 LLM 编出来的影子刊 → 整本刊不存在, 比任何数字编造都严重。
    //   放在正文编造闸**之前**: 影子刊的数字全都"有源"(源就是那条假记录), 正文编造闸必然放行。
    if (jGate.aiFabricatedJournal) {
      await db.update(contents)
        .set({ status: "needs_review", metadata: sql`COALESCE(${contents.metadata},'{}'::jsonb) || ${JSON.stringify({ needsReviewReason: "ai_fabricated_journal", aiFabricatedJournal: true })}::jsonb`, updatedAt: new Date() })
        .where(eq(contents.id, c.id));
      logger.warn({ contentId: c.id, journalId, journalIds }, "草稿分发硬闸: 关联刊是 AI 编造的影子刊(data_source=ai_fabricated), 剔除不进草稿箱, 转 needs_review");
      void import("../ops/incidents.js").then((m) => m.recordIncident({
        kind: "ai_fabricated_journal",
        severity: "error",
        tenantId,
        message: `草稿分发拦下影子刊内容(contentId=${c.id})`.slice(0, 500),
        detail: { contentId: c.id, stage: "draft_distribute", journalId, journalIds },
      })).catch(() => { /* 告警旁路, 不阻塞分发 */ });
      continue;
    }
    const fab = jGate.fabrication;
    if (fab.length > 0) {
      await db.update(contents)
        .set({ status: "needs_review", metadata: sql`COALESCE(${contents.metadata},'{}'::jsonb) || ${JSON.stringify({ needsReviewReason: "body_fabrication", bodyFabrication: fab })}::jsonb`, updatedAt: new Date() })
        .where(eq(contents.id, c.id));
      logger.warn({ contentId: c.id, journalId, fab }, "草稿分发硬闸: 正文编造无据IF/分区, 剔除不进草稿箱, 转 needs_review");
      continue;
    }
    // 7-28 (#6) 判据⑤ 软档: 源刊未过分体系可信门槛 → **不剔除**, 排队尾(核实过的先占名额)。
    //   两条来源都认: ① 生成期 batch-worker 标的 unverified_source_journal(见下方 TAIL_REASONS);
    //   ② 这里现查的结果 —— 覆盖 batch-worker 那道够不着的两类: 租户自己触发的生成
    //   (那道只在 SYSTEM 租户下判)、以及根本不走 batch-worker 的 roundup 多刊盘点。
    if (jGate.unverifiedJournal) unscoredIds.add(c.id);
    const reason = (c.metadata as { needsReviewReason?: string } | null)?.needsReviewReason;
    // 7-28 ②d: 把"闸没检查成"(quality_gate_unavailable)也归进队尾组 —— 与"没评上分"同一逻辑:
    //   不剔除(内容本身没查出问题), 但让检查全过的内容先占名额。
    if (c.status === "needs_review" && reason && TAIL_REASONS.has(reason)) unscoredIds.add(c.id);
    // snap 在上面的下限闸处已算过, 直接带走 —— 别在插入点二次读 metadata,
    //   那等于同一个判定算两遍, 两处迟早漂移。
    pool.push({ id: c.id, title: c.title, quality: snap });
  }
  // 7-27: 有分的排前面, 没评上分的垫底(stable, 组内仍保持 createdAt desc)。
  //   正常日子 unscoredIds 是空的, 排序等于没发生; 只有质检大面积挂掉那天才轮到它们顶上,
  //   把"零产出"换成"产出里混了几篇未评分的" —— 后者运营在草稿箱里一眼能认出来(有 needs_review 标),
  //   前者只会被无声吞掉。
  if (unscoredIds.size > 0) {
    const scored = pool.filter((p) => !unscoredIds.has(p.id));
    const unscored = pool.filter((p) => unscoredIds.has(p.id));
    pool.length = 0;
    pool.push(...scored, ...unscored);
    logger.info({ tenantId, scored: scored.length, unscored: unscored.length }, "7-27 可发池: 未评上分的内容排队尾(有分的优先)");
  }
  if (pool.length === 0) return [];

  // 排除"已推过草稿/已发布"的文章 — 按 contentId 整篇排除 (一篇只推一个号, 推过任何号就不再推)。
  // 7-28: 这一步同时是补救轮的**幂等保证** —— 主轮刚推成功的内容已落 content_publish_log,
  //   补救轮在这里被自动排除, 同一篇绝不会推两次(整个 cron 重跑也一样)。
  const poolIds = pool.map((p) => p.id);
  const logged = await db
    .select({ contentId: contentPublishLog.contentId })
    .from(contentPublishLog)
    .where(and(
      eq(contentPublishLog.tenantId, tenantId),
      inArray(contentPublishLog.contentId, poolIds),
      inArray(contentPublishLog.status, ["success", "draft", "draft_pushed", "dispatched"]),
    ));
  const usedIds = new Set(logged.map((r) => r.contentId));
  return pool.filter((p) => !usedIds.has(p.id));
  }; // ← buildFreshPool 结束

  // 3. 逐对推草稿 — 强制 draft_only; 单号失败(token 失效/API 挂)只记日志跳过, 不阻塞其他号
  const byAccount = new Map<string, DraftPushAccountReport>();
  for (const a of accounts) {
    byAccount.set(a.id, { accountId: a.id, accountName: a.accountName, pushed: [], errors: [] });
  }
  const pushPairs = async (
    pairs: Array<{ articleId: string; accountId: string }>,
    titleById: Map<string, string | null>,
    qualitySnapshotById: Map<string, QualitySnapshot>,
  ): Promise<number> => {
    let pushedNow = 0;
    for (const pair of pairs) {
      const acct = byAccount.get(pair.accountId);
      if (!acct) continue;
      try {
        const results = await publishToAccounts({
          contentId: pair.articleId,
          tenantId,
          accountIds: [pair.accountId],
          forceOverride: true, // 内容已过质检/采用, 且只进草稿箱(人工后台终审), 跳 audit gate 与 bulk-distribute 同策略
          overrideReason: "draft-distribute 草稿箱分发(仅建草稿, 运营后台终审)",
          capabilityOverride: "draft_only",
        });
        const r = results[0];
        if (r?.success) {
          // 落 log 防重复推: status='draft_pushed' (区别于浏览器推草稿的 'draft' 与真发布的 'success')
          // 🔴 8-20 质量快照: 冻结"按下发布键那一刻"的达标判定, 供将来接上 wechat_stats 后做对照组。
          //   为什么不直接读 contents.metadata、为什么三档、为什么不回填存量: 见 quality-verdict.ts 文件头。
          const vs = qualitySnapshotById.get(pair.articleId);
          await db.insert(contentPublishLog).values({
            tenantId,
            contentId: pair.articleId,
            accountId: pair.accountId,
            status: "draft_pushed",
            mediaId: r.mediaId ?? null,
            initiatedBy: "draft_dist",
            qualityVerdict: vs?.verdict ?? null,
            sixDimTotal: vs?.sixDimTotal != null ? String(vs.sixDimTotal) : null,
          }).onConflictDoUpdate({
            target: [contentPublishLog.contentId, contentPublishLog.accountId],
            // ⚠️ 冲突更新也写快照: 同一篇被重推时, 记的是**这一次**推送时的判定。
            //   漏掉的话重推行会保留上一次的 verdict, 与 status/media_id 描述的不是同一次事件。
            set: {
              status: "draft_pushed",
              mediaId: r.mediaId ?? null,
              initiatedBy: "draft_dist",
              qualityVerdict: vs?.verdict ?? null,
              sixDimTotal: vs?.sixDimTotal != null ? String(vs.sixDimTotal) : null,
              updatedAt: new Date(),
            },
          });
          acct.pushed.push({ contentId: pair.articleId, title: titleById.get(pair.articleId) ?? null });
          report.pushed++;
          pushedNow++;
        } else {
          const error = (r?.error || r?.reason || r?.message || "推草稿失败").slice(0, 200);
          acct.errors.push({ contentId: pair.articleId, error });
          report.failed++;
          logger.warn({ tenantId, accountId: pair.accountId, contentId: pair.articleId, error }, "草稿分发: 单篇失败, 跳过");
        }
      } catch (err) {
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        acct.errors.push({ contentId: pair.articleId, error });
        report.failed++;
        logger.warn({ tenantId, accountId: pair.accountId, contentId: pair.articleId, error }, "草稿分发: 单篇异常, 跳过");
      }
    }
    return pushedNow;
  };

  /**
   * 7-28 ①c: **实推后**的真实缺口(不是配对时的预期缺口)。
   * 为什么必须重算: computeSmartPairs 的 shortfalls 是"配对阶段没配上"的号, 而配上了却
   * 推失败(token 失效/微信 API 挂)的号在它眼里是达标的 —— 那正是最需要补的情况。
   * 口径与 smart-assign 的 preload 一致(今日 content_publish_log 全部状态计数)。
   */
  const computeEffectiveShortfalls = async (): Promise<DraftDistributeReport["shortfalls"]> => {
    const load = await countTodayAccountLoad(tenantId);
    return accounts
      .map((a) => ({ accountId: a.id, accountName: a.accountName ?? null, assigned: load.get(a.id) ?? 0, target }))
      .filter((x) => x.assigned < target);
  };

  // 4. 主轮: 近 POOL_WINDOW_DAYS 天的可发池 → 领域/定位匹配 → 推
  //    (复用 smart-assign; dailyCap=每号 top-N; 内部已按质检分排序=top 候选先占坑)
  const fresh = await buildFreshPool(POOL_WINDOW_DAYS);
  report.poolSize = fresh.length;
  let unmatchedCount = 0;
  if (fresh.length > 0) {
    const titleById = new Map(fresh.map((p) => [p.id, p.title]));
    const snapById = new Map(fresh.map((p) => [p.id, p.quality]));
    const { pairs, unmatched } = await computeSmartPairs({
      tenantId,
      articleIds: fresh.map((p) => p.id),
      accountIds: accounts.map((a) => a.id),
      dailyCap: perAccount, // 上限
      target,               // 7-14 保底下限: 两轮保底填到该数
    });
    unmatchedCount = unmatched.length;
    if (pairs.length > 0) await pushPairs(pairs, titleById, snapById);
  } else {
    report.skippedReason = "可发池为空";
  }

  // 5. 7-28 ①c 缺口补救 —— 从"只 logger.warn"升级成"落库 + 真去补"
  const shortBefore = await computeEffectiveShortfalls() ?? [];
  report.shortfalls = shortBefore;
  if (shortBefore.length > 0) {
    logger.warn(
      { tenantId, target, cap: perAccount, pool: report.poolSize, accounts: accounts.length, shortfalls: shortBefore },
      `⚠️ 草稿分发: ${shortBefore.length}/${accounts.length} 个号未达保底(${target}篇/天) — 内容不足, 尝试放宽时效窗口补救`,
    );

    const remedyWindow = Math.max(POOL_WINDOW_DAYS + 1, Math.floor(env.DRAFT_SHORTFALL_REMEDY_WINDOW_DAYS));
    if (!env.DRAFT_SHORTFALL_REMEDY_ENABLED) {
      report.remedy = { attempted: false, skippedReason: "disabled(DRAFT_SHORTFALL_REMEDY_ENABLED=false)" };
    } else {
      try {
        // 只放宽时效: 把 7 天窗口外、三周内、还没被推过的老内容拿出来补。
        // 对口/质检/红线/健康闸**一律不放宽** —— buildFreshPool 里那几道闸原样跑第二遍。
        const older = await buildFreshPool(remedyWindow);
        const shortIds = new Set(shortBefore.map((s) => s.accountId));
        if (older.length === 0) {
          report.remedy = { attempted: false, skippedReason: "no_extra_content", windowDays: remedyWindow, shortfallsBefore: shortBefore.length };
        } else {
          const titleById2 = new Map(older.map((p) => [p.id, p.title]));
          const snapById2 = new Map(older.map((p) => [p.id, p.quality]));
          const { pairs: pairs2 } = await computeSmartPairs({
            tenantId,
            articleIds: older.map((p) => p.id),
            accountIds: [...shortIds],   // 只补缺口号, 别顺手把达标号也塞满
            dailyCap: perAccount,
            target,
          });
          const pushed2 = pairs2.length > 0 ? await pushPairs(pairs2, titleById2, snapById2) : 0;
          report.remedy = {
            attempted: true, windowDays: remedyWindow, pushed: pushed2,
            shortfallsBefore: shortBefore.length,
          };
          logger.info({ tenantId, windowDays: remedyWindow, candidates: older.length, paired: pairs2.length, pushed: pushed2 },
            "7-28 ①c 缺口补救轮完成(只放宽时效窗口, 对口/质检/红线不变)");
        }
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        report.remedy = { attempted: true, windowDays: remedyWindow, error: msg, shortfallsBefore: shortBefore.length };
        logger.error({ tenantId, err: msg }, "7-28 ①c 缺口补救失败(主轮结果不受影响)");
        reportDistIncident({
          kind: "draft_remedy_failed", severity: "error", tenantId,
          message: `草稿缺口自动补救失败: ${msg}`,
          detail: { windowDays: remedyWindow, shortfallsBefore: shortBefore, error: msg },
        });
      }
    }

    // 补救后重算, 报告与告警都以**最终**缺口为准
    const shortAfter = await computeEffectiveShortfalls() ?? [];
    report.shortfalls = shortAfter;
    if (report.remedy) report.remedy.shortfallsAfter = shortAfter.length;

    if (shortAfter.length > 0) {
      // 严重度分档: 还有号**一条都没有**(assigned=0) → 红(该号今天彻底没东西发);
      //             只是没填满下限 → 黄(有货, 少了点)。
      const starved = shortAfter.filter((s) => s.assigned === 0);
      reportDistIncident({
        kind: "draft_shortfall",
        severity: starved.length > 0 ? "error" : "warn",
        tenantId,
        message: `${shortAfter.length}/${accounts.length} 个公众号未达每日保底(${target}篇)` +
          (starved.length > 0 ? `, 其中 ${starved.length} 个号今日 0 篇` : "") +
          `${report.remedy?.attempted ? `; 已自动补救(放宽到 ${report.remedy.windowDays} 天窗口)补进 ${report.remedy.pushed ?? 0} 篇` : ""}` +
          ` — 内容不够分, 需提高生成量或补期刊/选题`,
        detail: {
          target, cap: perAccount, accounts: accounts.length,
          poolSize: report.poolSize, unmatched: unmatchedCount,
          shortfallsBefore: shortBefore, shortfallsAfter: shortAfter,
          remedy: report.remedy ?? null,
        },
      });
    } else {
      logger.info({ tenantId, remedy: report.remedy }, "7-28 ①c 缺口已被补救轮填平, 不告警");
    }
  }

  report.perAccount = [...byAccount.values()];
  // 主轮池空但补救轮补上了 → "可发池为空"这句已经不成立, 清掉免得报告自相矛盾
  if (report.pushed > 0) report.skippedReason = undefined;
  if (report.pushed === 0 && !report.skippedReason) {
    report.skippedReason = unmatchedCount > 0 ? `无可配对内容 (unmatched=${unmatchedCount})` : "本轮无内容可推";
  }
  logger.info(
    { tenantId, pushed: report.pushed, failed: report.failed, pool: report.poolSize, unmatched: unmatchedCount, remedy: report.remedy },
    "草稿分发: 租户完成",
  );
  return report;
}

/** 全租户跑一轮 (cron 入口)。单租户失败不阻塞其他租户。 */
export async function runDraftDistribute(): Promise<{ tenantsProcessed: number; reports: DraftDistributeReport[] }> {
  const activeTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), sql`${tenants.id} != ${SYSTEM_RECOMMENDATION_TENANT_ID}::uuid`));
  const reports: DraftDistributeReport[] = [];
  for (const t of activeTenants) {
    try {
      reports.push(await distributeDraftsForTenant(t.id));
    } catch (err) {
      logger.error({ tenantId: t.id, err: err instanceof Error ? err.message : err }, "草稿分发: 租户失败 (跳过)");
    }
  }
  return { tenantsProcessed: activeTenants.length, reports };
}
