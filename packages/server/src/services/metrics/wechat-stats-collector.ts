/**
 * 7-06 ①② 公众号发布效果数据回流 — 把系统从"发出去就不管了"升级为"读者数据回流反哺"。
 *
 * 每日 WECHAT_STATS_CRON_HOUR (默认 09:00 BJ, scheduler 注册) 对每个绑定公众号的账号拉
 * "昨日" getarticlesummary (微信图文分析数据, T+1 出数), 逐篇匹配回 contents 并写 content_metrics。
 *
 * 微信 API 事实 (7-06 核查):
 *   - POST https://api.weixin.qq.com/datacube/getarticlesummary {begin_date, end_date} (跨度=1天)
 *     返回每篇 { ref_date, msgid, title, int_page_read_count(阅读), share_count(分享),
 *     add_to_fav_count(收藏) } — datacube 不提供"在看"字段, 用收藏(saves)替代。
 *   - token 体系兼容: 与发布适配器同一 client_credential access_token (appId/appSecret 直连,
 *     非第三方平台), 复用 ensureFreshAccessToken 缓存+落库。
 *   - 权限: 数据分析接口需微信认证公众号; 未认证订阅号返回 48001 等 → 优雅跳过记日志。
 *
 * 匹配 (title-match.ts 纯函数):
 *   - 自动发布/推草稿的: content_publish_log 有该账号记录 → 候选池优先 (log 里只有草稿 media_id,
 *     群发后的 msgid 微信不回传给 draft/freepublish 链路, 所以精确匹配也走"标题去空白全等")
 *   - 运营手动群发的: 标题精确 → 模糊(前缀20字/编辑距离) → 仍不上落"未匹配清单"日志, 绝不硬塞
 *
 * 写入 (复用 recordMetric → content_metrics, 红线 #11):
 *   - getarticlesummary 返回的是"当日增量"; content_metrics 现有消费方 (roi.ts / asset-performance)
 *     都取"每内容最新快照"当总量 → 我们按日写【累计快照】: views = 前一日快照累计 + 当日增量,
 *     当日增量另存 metadata.dailyReadDelta (dashboard "今日阅读"聚合用)。
 *   - 幂等: recordMetric 按 (contentId, platform, snapshotDate) upsert, 前值只取 snapshot < 当日,
 *     同账号同日重跑结果一致, 不重复计。
 *
 * ② 运营选择信号:
 *   - 推过草稿 (draft_pushed/draft) 的文章出现在已发布数据里 → log 升级 status='published_by_operator'
 *   - 发布标题 ≠ 我们推送标题 → contents.metadata.titleFeedback = {pushed, published, at} (标题课)
 *   - 推了草稿 7 天没被发布 → status='draft_expired' (负信号)
 */
import { and, desc, eq, gte, lt, or } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contentMetrics, contentPublishLog, contents, platformAccounts } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { logger } from "../../config/logger.js";
import { decryptCredentialField, ensureFreshAccessToken } from "../publisher/credentials-loader.js";
import { recordMetric } from "./roi.js";
import { matchArticleToContent, normalizeTitle } from "./title-match.js";

const WX_API = "https://api.weixin.qq.com/cgi-bin";
const DATACUBE_API = "https://api.weixin.qq.com/datacube";
const CANDIDATE_WINDOW_DAYS = 45; // 候选内容回看窗口 (>7天草稿过期线 + 老文长尾)
const DRAFT_EXPIRE_DAYS = 7;      // 推草稿 N 天未发布 → draft_expired 负信号

// 数据分析接口无权限的错误码 (未认证订阅号常见): 48001 api unauthorized / 50002 用户受限 / 61007 权限不足
const NO_PERMISSION_ERRCODES = new Set([48001, 50002, 61007]);

interface WxArticleSummaryRow {
  ref_date?: string;
  msgid?: string;
  title?: string;
  int_page_read_user?: number;
  int_page_read_count?: number;
  share_user?: number;
  share_count?: number;
  add_to_fav_user?: number;
  add_to_fav_count?: number;
}

export interface WechatStatsAccountReport {
  accountId: string;
  accountName: string;
  articles: number;          // 当日已发布图文篇数 (getarticlesummary 返回行聚合后)
  matchedExact: number;
  matchedFuzzy: number;
  operatorPublished: number; // ② draft_pushed → published_by_operator 升级数
  titleFeedback: number;     // ② 捕捉到运营改标题的篇数
  unmatched: string[];       // 未匹配清单 (标题+阅读数, 只记日志不塞数据)
  skippedReason?: string;    // 无权限/token失效等跳过原因
}

export interface WechatStatsRunReport {
  date: string;
  accountsProcessed: number;
  matched: number;
  unmatched: number;
  expiredDrafts: number;
  perAccount: WechatStatsAccountReport[];
}

/** 北京时区"昨日" YYYY-MM-DD (getarticlesummary T+1, 最多查到昨天) */
export function bjYesterday(now = Date.now()): string {
  return new Date(now + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
}

/** 拉取单账号某日 getarticlesummary。无权限/失败抛错或返回 null 由调用方兜。 */
async function fetchArticleSummary(token: string, date: string): Promise<{ list: WxArticleSummaryRow[] } | { errcode: number; errmsg: string }> {
  const resp = await fetch(`${DATACUBE_API}/getarticlesummary?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ begin_date: date, end_date: date }),
  });
  const data = await resp.json() as any;
  if (data.errcode && data.errcode !== 0) return { errcode: data.errcode, errmsg: data.errmsg ?? "" };
  return { list: Array.isArray(data.list) ? data.list : [] };
}

/** 同标题多行(多图文/接口重复行)聚合成一篇 */
export function aggregateSummaryRows(rows: WxArticleSummaryRow[]): Array<{
  title: string; reads: number; shares: number; favs: number; msgids: string[];
}> {
  const byTitle = new Map<string, { title: string; reads: number; shares: number; favs: number; msgids: string[] }>();
  for (const r of rows) {
    const title = (r.title ?? "").trim();
    if (!title) continue;
    const key = normalizeTitle(title);
    const agg = byTitle.get(key) ?? { title, reads: 0, shares: 0, favs: 0, msgids: [] };
    agg.reads += Math.max(0, Math.floor(r.int_page_read_count ?? 0));
    agg.shares += Math.max(0, Math.floor(r.share_count ?? 0));
    agg.favs += Math.max(0, Math.floor(r.add_to_fav_count ?? 0));
    if (r.msgid) agg.msgids.push(String(r.msgid));
    byTitle.set(key, agg);
  }
  return [...byTitle.values()];
}

/** ② 负信号: 推了草稿 DRAFT_EXPIRE_DAYS 天仍未出现在发布数据 → draft_expired */
export async function expireStaleDraftPushes(): Promise<number> {
  const cutoff = new Date(Date.now() - DRAFT_EXPIRE_DAYS * 86400_000);
  const res: any = await db
    .update(contentPublishLog)
    .set({ status: "draft_expired", updatedAt: new Date() })
    .where(and(eq(contentPublishLog.status, "draft_pushed"), lt(contentPublishLog.updatedAt, cutoff)));
  const n = Number(res?.rowCount ?? 0);
  if (n > 0) logger.info({ expired: n, days: DRAFT_EXPIRE_DAYS }, "7-06 ② 草稿过期负信号: draft_pushed → draft_expired");
  return n;
}

/** 单账号回流一日数据 */
async function collectForAccount(
  account: { id: string; tenantId: string; accountName: string; credentials: unknown },
  date: string,
): Promise<WechatStatsAccountReport> {
  const report: WechatStatsAccountReport = {
    accountId: account.id, accountName: account.accountName,
    articles: 0, matchedExact: 0, matchedFuzzy: 0, operatorPublished: 0, titleFeedback: 0, unmatched: [],
  };

  // 1. 解密凭证 + access token (复用发布链路 token 体系, 刷新自动落库)
  const creds = decryptCredentialField(account.credentials);
  if (!creds.appId || !creds.appSecret) {
    report.skippedReason = "缺少 appId/appSecret";
    return report;
  }
  const token = await ensureFreshAccessToken({
    accountId: account.id,
    tenantId: account.tenantId,
    credentials: creds,
    refresh: async () => {
      const resp = await fetch(`${WX_API}/token?grant_type=client_credential&appid=${creds.appId}&secret=${creds.appSecret}`);
      const data = await resp.json() as any;
      if (data.errcode) throw new Error(`获取token失败: ${data.errcode} - ${data.errmsg}`);
      return { accessToken: data.access_token, expiresInSec: Number(data.expires_in) || 7200 };
    },
  });

  // 2. 拉当日图文分析数据
  const summary = await fetchArticleSummary(token, date);
  if ("errcode" in summary) {
    if (NO_PERMISSION_ERRCODES.has(summary.errcode)) {
      // 未认证公众号无数据分析权限 — 预期内, 优雅跳过 (运营仍可手填 /today/metrics)
      report.skippedReason = `无数据分析权限 (${summary.errcode}: ${summary.errmsg}) — 需微信认证公众号`;
      logger.info({ accountId: account.id, accountName: account.accountName, errcode: summary.errcode }, "7-06 ① 该号无数据分析权限, 跳过");
    } else {
      report.skippedReason = `getarticlesummary 失败 (${summary.errcode}: ${summary.errmsg})`;
      logger.warn({ accountId: account.id, errcode: summary.errcode, errmsg: summary.errmsg }, "7-06 ① 拉取图文数据失败, 跳过该号");
    }
    return report;
  }
  const articles = aggregateSummaryRows(summary.list);
  report.articles = articles.length;
  if (articles.length === 0) return report;

  // 3. 候选池: 该账号 publish_log 关联内容(优先) + 本租户/共享池近 45 天文章(兜底, 运营手动搬运场景)
  const since = new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86400_000);
  const logRows = await db
    .select({ contentId: contentPublishLog.contentId, logStatus: contentPublishLog.status, title: contents.title })
    .from(contentPublishLog)
    .innerJoin(contents, eq(contents.id, contentPublishLog.contentId))
    .where(and(eq(contentPublishLog.accountId, account.id), gte(contentPublishLog.createdAt, since)));
  const logByContent = new Map(logRows.map((r) => [r.contentId, r]));

  const poolRows = await db
    .select({ id: contents.id, title: contents.title })
    .from(contents)
    .where(and(
      or(eq(contents.tenantId, account.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      eq(contents.type, "article"),
      gte(contents.createdAt, since),
    ))
    .orderBy(desc(contents.createdAt))
    .limit(800);
  // log 关联的排前面 (账号自己的记录优先命中), 池子里去重补后
  const candidates = [
    ...logRows.map((r) => ({ contentId: r.contentId, title: r.title })),
    ...poolRows.filter((p) => !logByContent.has(p.id)).map((p) => ({ contentId: p.id, title: p.title })),
  ];

  // 4. 逐篇匹配 + 写指标 + ② 信号
  for (const art of articles) {
    const match = matchArticleToContent(art.title, candidates);
    if (!match) {
      report.unmatched.push(`《${art.title}》阅读${art.reads}`);
      continue;
    }
    if (match.matchType === "exact") report.matchedExact++;
    else report.matchedFuzzy++;

    // 4a. 累计快照写入: 前值只取 snapshot < 当日 → 同日重跑幂等 (upsert 覆盖同日行)
    const [prev] = await db
      .select({
        views: contentMetrics.views, likes: contentMetrics.likes, shares: contentMetrics.shares,
        saves: contentMetrics.saves, followers: contentMetrics.followers, inquiries: contentMetrics.inquiries,
      })
      .from(contentMetrics)
      .where(and(
        eq(contentMetrics.contentId, match.contentId),
        eq(contentMetrics.platform, "wechat"),
        lt(contentMetrics.snapshotDate, date),
      ))
      .orderBy(desc(contentMetrics.snapshotDate))
      .limit(1);
    await recordMetric({
      tenantId: account.tenantId,
      contentId: match.contentId,
      accountId: account.id,
      platform: "wechat",
      views: (prev?.views ?? 0) + art.reads,
      shares: (prev?.shares ?? 0) + art.shares,
      saves: (prev?.saves ?? 0) + art.favs,
      likes: prev?.likes ?? 0,           // 手填历史值透传, 不清零
      followers: prev?.followers ?? 0,
      inquiries: prev?.inquiries ?? 0,
      source: "api",
      snapshotDate: date,
      metadataExtra: {
        dailyReadDelta: art.reads, dailyShareDelta: art.shares, dailyFavDelta: art.favs,
        msgids: art.msgids.slice(0, 8), matchType: match.matchType, wxTitle: art.title, refDate: date,
      },
    });

    // 4b. ② 运营选择信号: 推过草稿的文章出现在发布数据 = 运营在后台选了它群发
    const logRow = logByContent.get(match.contentId);
    if (logRow && (logRow.logStatus === "draft_pushed" || logRow.logStatus === "draft")) {
      await db.update(contentPublishLog)
        .set({ status: "published_by_operator", updatedAt: new Date() })
        .where(and(eq(contentPublishLog.contentId, match.contentId), eq(contentPublishLog.accountId, account.id)));
      report.operatorPublished++;
      logger.info({ contentId: match.contentId, accountId: account.id, title: art.title }, "7-06 ② 市场选择信号: 运营已选发 (draft_pushed → published_by_operator)");
    } else if (!logRow) {
      // 运营手动搬运发布(无任何 log 行) — 也补一条选择信号记录
      await db.insert(contentPublishLog).values({
        tenantId: account.tenantId, contentId: match.contentId, accountId: account.id,
        status: "published_by_operator", initiatedBy: "stats",
      }).onConflictDoNothing();
      report.operatorPublished++;
    }

    // 4c. ② 标题修改捕捉: 发布标题 ≠ 我们的标题 → titleFeedback (运营改标题 = 最真实的标题课)
    const [c] = await db
      .select({ title: contents.title, metadata: contents.metadata })
      .from(contents)
      .where(eq(contents.id, match.contentId))
      .limit(1);
    if (c && normalizeTitle(c.title) !== normalizeTitle(art.title)) {
      const meta = {
        ...((c.metadata as Record<string, unknown>) ?? {}),
        titleFeedback: { pushed: c.title ?? "", published: art.title, at: new Date().toISOString(), accountId: account.id },
      };
      await db.update(contents).set({ metadata: meta, updatedAt: new Date() }).where(eq(contents.id, match.contentId));
      report.titleFeedback++;
      logger.info({ contentId: match.contentId, pushed: c.title, published: art.title }, "7-06 ② 标题修改捕捉: 运营改了标题 (titleFeedback 已落 metadata)");
    }
  }

  if (report.unmatched.length > 0) {
    // 未匹配清单 — 只记日志便于人工核对, 绝不塞错数据
    logger.warn({ accountId: account.id, accountName: account.accountName, date, unmatched: report.unmatched }, "7-06 ① 未匹配清单: 已发布文章匹配不到 contents");
  }
  return report;
}

/** cron 主入口: 全部启用中的公众号跑一轮 (默认拉"昨日"), 单号失败不阻塞其他号 */
export async function runWechatStatsCollection(opts?: { date?: string }): Promise<WechatStatsRunReport> {
  const date = opts?.date ?? bjYesterday();
  const accounts = await db
    .select({
      id: platformAccounts.id, tenantId: platformAccounts.tenantId,
      accountName: platformAccounts.accountName, credentials: platformAccounts.credentials,
    })
    .from(platformAccounts)
    .where(and(eq(platformAccounts.platform, "wechat"), eq(platformAccounts.status, "active")));

  const perAccount: WechatStatsAccountReport[] = [];
  for (const a of accounts) {
    try {
      perAccount.push(await collectForAccount(a, date));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ accountId: a.id, accountName: a.accountName, err: msg }, "7-06 ① 单号回流异常, 跳过");
      perAccount.push({
        accountId: a.id, accountName: a.accountName, articles: 0, matchedExact: 0, matchedFuzzy: 0,
        operatorPublished: 0, titleFeedback: 0, unmatched: [], skippedReason: msg.slice(0, 200),
      });
    }
  }

  const expiredDrafts = await expireStaleDraftPushes();
  const matched = perAccount.reduce((n, r) => n + r.matchedExact + r.matchedFuzzy, 0);
  const unmatched = perAccount.reduce((n, r) => n + r.unmatched.length, 0);
  const summary: WechatStatsRunReport = { date, accountsProcessed: accounts.length, matched, unmatched, expiredDrafts, perAccount };
  logger.info({ date, accounts: accounts.length, matched, unmatched, expiredDrafts }, "7-06 ① 公众号效果数据回流完成");
  return summary;
}
