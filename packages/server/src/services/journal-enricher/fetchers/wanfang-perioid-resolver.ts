/**
 * 万方 perioId 自动解析器（task#104 阶段2）。
 *
 * 背景（红线 #11）：wanfang-fetcher.ts 已能按 perioId 抓 med SSR 详情页，但 perioId
 * 之前只能 admin 手动预填 → 从没规模化。本模块补上"按 ISSN 优先 / 刊名兜底"自动
 * 解析 perioId 的那一环，解析到就写回 journals.metadata.wanfang.perioId（幂等，
 * 下次富化直接用，不用重解析）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * ⚠️ 探路结论（2026-07-16，Cowork 沙盒实测，务必让 CC 在桌面复核）：
 *   - 沙盒 bash 无外网；web_fetch 能取到 med.wanfangdata.com.cn/ 首页 SSR，但
 *     /Periodical/Search 与 /Periodical/Detail/{id} 返回空（被反爬/需 JS/抽取为空，
 *     无法判定是否真死）。s.wanfangdata.com.cn/perio 与 c.wanfangdata.com.cn/periodical
 *     是纯 JS SPA，SSR HTML 里没有结果、没有 perioId。
 *   - 因此"med SSR 搜索页能否直接 regex 出 perioId"未在沙盒验证通过。
 *   - 本模块把「HTML → perioId」的解析逻辑做成纯函数 parsePerioIdFromSearchHtml
 *     （已单测），抓取端点 SEARCH_URL 标为"待桌面验证"。CC 在桌面（真住宅网络，
 *     verify-wanfang-trial.ts 的运行环境）跑一次，若 med 搜索页结构与本文件假设
 *     不符，只需改 SEARCH_URL / 或往 parse 里加一条 href 正则即可，不用重写。
 * ────────────────────────────────────────────────────────────────────────
 *
 * 合规：复用 wanfang-fetcher 的 UA 池 + Referer + retry（fetchWanfangHtml），
 * 节流由调用方（批量脚本 10s±3s）控制，本模块不并发。
 */
import { logger } from "../../../config/logger.js";
import { fetchWanfangHtml } from "./wanfang-fetcher.js";
import { isDomesticKind, toJournalKind } from "../../journals/journal-kind.js";

/** med 子域期刊搜索入口（SSR）。待桌面验证；可被 env WANFANG_SEARCH_BASE 覆盖便于修补。 */
const WANFANG_SEARCH_BASE =
  process.env.WANFANG_SEARCH_BASE || "https://med.wanfangdata.com.cn/Periodical/Search";

const ISSN_RE = /\b\d{4}-\d{3}[\dXx]\b/;
const PERIOID_RE = /^[a-z0-9_-]+$/i;

export interface PerioIdMatch {
  perioId: string;
  /** issn=按 ISSN 命中（最稳）；name_exact=刊名精确；name_fuzzy=刊名包含（兜底，需人工复核） */
  matchType: "issn" | "name_exact" | "name_fuzzy";
}

interface Candidate {
  perioId: string;
  anchorText: string;
  /** anchor 在原 HTML 里的起始下标（用于把 ISSN 归到"最近的前一个 anchor"） */
  index: number;
}

/** ISSN 归属的最大距离：anchor 与其后 ISSN 相隔超过此值就不算同一条结果 */
const ISSN_PROXIMITY = 800;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从万方搜索结果 HTML 抠出候选 perioId 列表。
 * 7-16 桌面实抓校准（真实 med SSR）：结果链接是 href="/Periodical/{短码}"（如 /Periodical/zhyx），
 *   非早前假设的 /Periodical/Detail/{id}。主匹配改成短码形态，旧形态保留作兜底（万方哪天改回来不全挂）。
 * 兼容三种链接形态（按优先级）：
 *   - med SSR 实况: href="/Periodical/{perioId}"  ← 现网真实格式
 *   - 旧假设兜底:   href="/Periodical/Detail/{perioId}"
 *   - SPA 兜底:     href="/perio/{perioId}"
 * 短码字符集限 [a-z0-9]（不含 . / 等）→ 天然拒路径穿越; 负向前瞻排除 Detail/Search/cnki 等非期刊噪音 href。
 */
export function extractPerioIdCandidates(html: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const linkRe =
    /<a\b[^>]*href=["'](?:https?:\/\/[^"'/]+)?\/(?:Periodical\/Detail\/|perio\/|Periodical\/(?!Detail\b|Search\b|cnki\b))([a-z0-9]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const perioId = m[1];
    if (!PERIOID_RE.test(perioId) || perioId.length < 2 || perioId.length > 40) continue;
    const key = perioId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const anchorText = stripTags(m[2]);
    out.push({ perioId, anchorText, index: m.index });
  }
  return out;
}

/**
 * 纯函数：给定搜索 HTML + 目标 ISSN/刊名，选出最佳 perioId。
 * 匹配优先级：ISSN 就近命中 > 刊名精确 > 刊名包含（兜底）。选不到 return null。
 */
export function parsePerioIdFromSearchHtml(
  html: string,
  opts: { issn?: string | null; nameZh?: string | null },
): PerioIdMatch | null {
  if (!html || html.length < 200) return null;
  const candidates = extractPerioIdCandidates(html);
  if (candidates.length === 0) return null;

  const issn = (opts.issn ?? "").trim().toUpperCase();
  const nameZh = stripTags(opts.nameZh ?? "");

  // 1) ISSN 命中（最可信）：把 HTML 里出现的目标 ISSN 归到"最近的前一个 anchor"。
  //    （早前用前后固定窗口会把下一条结果的 ISSN 误算进上一条 → 取错 perioId，已修）
  if (issn && ISSN_RE.test(issn)) {
    const issnRe = new RegExp(escapeRegExp(issn), "gi");
    let mm: RegExpExecArray | null;
    while ((mm = issnRe.exec(html)) !== null) {
      const pos = mm.index;
      let best: Candidate | null = null;
      for (const c of candidates) {
        if (c.index <= pos && pos - c.index < ISSN_PROXIMITY && (!best || c.index > best.index)) {
          best = c;
        }
      }
      if (best) return { perioId: best.perioId, matchType: "issn" };
    }
  }

  // 2) 刊名精确（anchor 文本 == 刊名）
  if (nameZh) {
    const exact = candidates.find((c) => c.anchorText === nameZh);
    if (exact) return { perioId: exact.perioId, matchType: "name_exact" };

    // 3) 刊名包含（兜底，标 fuzzy 让上层/人工复核）；仅当唯一命中才采，多命中不猜
    const fuzzy = candidates.filter(
      (c) => c.anchorText && (c.anchorText.includes(nameZh) || nameZh.includes(c.anchorText)),
    );
    if (fuzzy.length === 1) return { perioId: fuzzy[0].perioId, matchType: "name_fuzzy" };
  }

  return null;
}

/**
 * 抓万方搜索页并解析 perioId。ISSN 优先查一次；未命中再按刊名查一次。
 * 复用 fetchWanfangHtml（UA 池/retry/4xx→null）。任何失败 return null（不阻塞、不抛）。
 *
 * 注意：本函数只发 1~2 次请求，不含节流；批量调用方须自行 10s±3s 限速（合规优先）。
 */
export async function resolveWanfangPerioId(input: {
  issn?: string | null;
  nameZh?: string | null;
}): Promise<PerioIdMatch | null> {
  const issn = (input.issn ?? "").trim();
  const nameZh = (input.nameZh ?? "").trim();
  if (!issn && !nameZh) return null;

  // 查询词优先级：ISSN（若合法）→ 刊名。两个都试，直到解析出 perioId。
  const queries: string[] = [];
  if (issn && ISSN_RE.test(issn.toUpperCase())) queries.push(issn);
  if (nameZh) queries.push(nameZh);

  for (const q of queries) {
    const url = `${WANFANG_SEARCH_BASE}?q=${encodeURIComponent(q)}`;
    const html = await fetchWanfangHtml(url, "wanfang.periodical.search");
    if (!html) continue;
    const match = parsePerioIdFromSearchHtml(html, { issn, nameZh });
    if (match) {
      logger.debug({ q, perioId: match.perioId, matchType: match.matchType }, "wanfang perioId 解析成功");
      return match;
    }
  }
  logger.debug({ issn, nameZh }, "wanfang perioId 解析未命中（搜索无结果 / 反爬 / 结构变更）");
  return null;
}

// ─────────── 批量选池纯函数（放这里避免测试拉起 DB 层） ───────────

/** 批量选池候选行（DB 投影 + pure 过滤用） */
export interface WanfangCandidateRow {
  id: string;
  name: string | null;
  nameEn: string | null;
  issn: string | null;
  catalogs: unknown;
  cscdLevel: string | null;
  pkuCoreLevel: string | null;
  metadata: unknown;
}

/** 取 metadata.wanfang.perioId（安全解构，非法/空 → null） */
export function getExistingPerioId(metadata: unknown): string | null {
  const wf = (metadata as Record<string, any> | null)?.wanfang;
  const pid = wf?.perioId;
  return typeof pid === "string" && pid.trim() ? pid.trim() : null;
}

/**
 * 纯函数选池：从行集里挑"可自动富化的国内刊"。
 * 条件：①国内刊（journal_kind 落 cn/both，见 services/journals/journal-kind.ts）
 *      ②metadata.wanfang.perioId 为空（断点续跑：已解析过的跳过）
 *      ③有可搜索的中文刊名（≥3 字，万方按中文名/ISSN 搜）
 */
export function selectWanfangCandidates(rows: WanfangCandidateRow[]): WanfangCandidateRow[] {
  return rows.filter((r) => {
    // 7-28 (③b): 国内刊判定收口到 journal_kind 单一真相源(原来这里手写了第 2 套启发式)。
    //   kind='cn'(纯国内) 或 'both'(骑墙刊, 有国际指标又进中文目录) 都该去万方解析 perioId。
    if (!isDomesticKind(toJournalKind(r))) return false;
    if (getExistingPerioId(r.metadata)) return false; // 已有 perioId，跳过
    if (!r.name || r.name.trim().length < 3) return false; // 刊名太短没法搜
    return true;
  });
}
