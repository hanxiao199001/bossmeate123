/**
 * publication_costs extractor（B.2.1.A）
 *
 * Input: DOAJ record (OA 期刊有) + journal.apcFee (DB 已有的 USD APC, 兜底)
 * Output: PublicationCostsShape | null
 *
 * 数据源优先级：
 *   1. DOAJ has_apc + max[].price/currency  →  source = "doaj"，openAccess = true
 *   2. journal.apcFee (DB 已有字段)         →  source = "journal_apc_field"
 *      此时 openAccess 不能从这个字段判断（保守留 undefined）
 *   3. 都没有 → null
 *
 * 护栏（spec 要求）：
 *   非 OA 期刊 (DOAJ 查不到) 且 apcFee == null  →  返回 null（不要乱写）
 *   非 OA 期刊但 DOAJ 意外返回了 APC（不应发生）→ orchestrator 端会单独 log warn
 */

import type { PublicationCostsShape, DoajJournalRecord } from "../types.js";

export interface CostsInput {
  doaj: DoajJournalRecord | null;
  journalApcFee?: number | null; // DB existing column
}

export function extractPublicationCosts(input: CostsInput): PublicationCostsShape | null {
  const { doaj, journalApcFee } = input;

  // 优先 DOAJ
  if (doaj && doaj.bibjson) {
    const apcInfo = doaj.bibjson.apc;
    if (apcInfo && apcInfo.has_apc && Array.isArray(apcInfo.max) && apcInfo.max.length > 0) {
      const top = apcInfo.max[0];
      if (typeof top.price === "number" && top.price >= 0) {
        return {
          apc: top.price,
          currency: top.currency || "USD",
          openAccess: true, // DOAJ 收录 = OA
          fastTrack: false, // DOAJ 不区分，默认 false
          source: "doaj",
          lastUpdatedAt: new Date().toISOString(),
        };
      }
    }
    // DOAJ 收录但 has_apc=false 或没价格：这是免费 OA 期刊（Diamond OA）
    if (apcInfo && apcInfo.has_apc === false) {
      return {
        apc: 0,
        currency: "USD",
        openAccess: true,
        fastTrack: false,
        source: "doaj",
        lastUpdatedAt: new Date().toISOString(),
      };
    }
  }

  // 兜底：DB 已有 apcFee 字段（多为非 OA 期刊的 page charge 估值）
  if (typeof journalApcFee === "number" && journalApcFee > 0) {
    return {
      apc: journalApcFee,
      currency: "USD",
      openAccess: undefined, // 不知道
      fastTrack: undefined,
      source: "journal_apc_field",
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  return null;
}
