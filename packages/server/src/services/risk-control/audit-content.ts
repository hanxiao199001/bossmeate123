/**
 * 5-20 P2 — 风控审核核心。content title+body 跨平台 dict 扫描，返回 hits + 偏移。
 *
 * 输入: { content, platforms }
 * 输出: { hits: AuditHit[], summary }
 *
 * V1 简化: 全 severity="medium"; 未来按 dict 标 severity (high=封号 / medium=警告 / low=提示)。
 */
import { getDictForPlatform } from "./dictionaries/index.js";

export interface AuditHit {
  platform: string;
  word: string;
  positions: number[]; // 字符级偏移，frontend 用于高亮
  severity: "high" | "medium" | "low";
}

export interface AuditResult {
  hits: AuditHit[];
  summary: { totalHits: number; byPlatform: Record<string, number> };
}

export interface AuditParams {
  content: { title: string | null; body: string | null };
  platforms: string[];
}

/**
 * 在文本中找 word 全部出现位置（O(n*m)，简单实现；dict 不大无需 Aho-Corasick）。
 */
function findAllPositions(text: string, word: string): number[] {
  const positions: number[] = [];
  if (!word) return positions;
  let idx = text.indexOf(word);
  while (idx >= 0) {
    positions.push(idx);
    idx = text.indexOf(word, idx + 1);
  }
  return positions;
}

export async function auditContent(params: AuditParams): Promise<AuditResult> {
  const text = `${params.content.title ?? ""}\n${params.content.body ?? ""}`;
  const hits: AuditHit[] = [];

  for (const platform of params.platforms) {
    const dict = getDictForPlatform(platform);
    for (const word of dict) {
      const positions = findAllPositions(text, word);
      if (positions.length > 0) {
        hits.push({ platform, word, positions, severity: "medium" });
      }
    }
  }

  const byPlatform: Record<string, number> = {};
  for (const h of hits) byPlatform[h.platform] = (byPlatform[h.platform] || 0) + 1;

  return { hits, summary: { totalHits: hits.length, byPlatform } };
}
