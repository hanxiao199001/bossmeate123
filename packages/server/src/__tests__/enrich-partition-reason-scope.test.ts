import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isDomesticKind, toJournalKind } from "../services/journals/journal-kind.js";
import { hasAnyFact, PARTITION_FACT_KEYS } from "../services/compliance/fabrication-criteria.js";

/**
 * 「缺分区证据」只对国际体系刊构成富化理由 (7-29)。
 *
 * ## 病史(两轮才修完, 值得写下来)
 *
 * 原判据是 `!journal.casPartition` —— 而 cas_partition **整库 0 行**(死列), 于是这一项
 * 恒为真 → needsEnrichment 恒为真 → **每篇文章都触发一次 LetPub 抓取 + 一次 LLM 调用**。
 * 它不报错、不改数据、只是多花钱多耗时, 所以从上线起就没被发现。
 *
 *   · 7-28 第一轮: 改判**全部四类分区证据**(PARTITION_FACT_KEYS)。国际刊修好了 ——
 *     生产 4407/8650 本因此不再触发。但国内刊仍恒真, 当时标为"已知限制"。
 *   · 7-29 第二轮(本测试锁的): 国内刊**客观上就没有**中科院/JCR 分区, 拿"缺分区"当富化
 *     理由永远成立; 而 LetPub/Springer 链路对国内刊本来也抓不到东西 —— 白跑。
 *     生产实测这一半是 cn 3593 + unknown 538 本。
 *
 * ## 这里锁的是**语义**, 不是文本
 *
 * 只断言两件事: ① 判据组合出来的行为对(纯函数复算, 与实现同源);
 * ② 源码里确实按 journal_kind 分了流(防止有人"顺手简化"回恒真式)。
 * 不去正则匹配整行代码 —— 那是红线 #12 说的"守文本不守行为", 等价重构就假红。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../services/skills/article-skill.ts"), "utf8");

/** 与 article-skill 里 lacksPartitionEvidence 同一套组合(改一边这里就该红) */
function lacksPartitionEvidence(j: Parameters<typeof toJournalKind>[0] & Record<string, unknown>): boolean {
  const isDomestic = isDomesticKind(toJournalKind(j));
  return !isDomestic && !hasAnyFact(j, PARTITION_FACT_KEYS);
}

describe("缺分区证据 → 只对国际刊算富化理由", () => {
  it("国内刊(有目录标签)不因缺分区触发 —— 它客观就没有分区, 且 LetPub 抓不到", () => {
    const cnJournal = { catalogs: ["pku-core"], name: "中国高教研究" };
    expect(toJournalKind(cnJournal)).toBe("cn");
    expect(lacksPartitionEvidence(cnJournal)).toBe(false);
  });

  it("只有 cscd_level / pku_core_level 的裂缝刊同样不触发(catalogs 是空的)", () => {
    const gap = { catalogs: [], cscdLevel: "核心库", name: "某学报" };
    expect(toJournalKind(gap)).toBe("cn");
    expect(lacksPartitionEvidence(gap)).toBe(false);
  });

  it("国际刊缺全部四类分区证据 → 仍要触发(这才是原意图)", () => {
    const intlNoPartition = { catalogs: [], impactFactor: 3.2, name: "Some Journal" };
    expect(toJournalKind(intlNoPartition)).toBe("intl");
    expect(lacksPartitionEvidence(intlNoPartition)).toBe(true);
  });

  it("国际刊有任一分区证据 → 不触发(7-28 修的那半)", () => {
    for (const evidence of [
      { partition: "Q1" },
      { casPartition: "1区" },
      { casPartitionNew: "3区医学" },
      { jcrFull: { wosLevel: "SCIE" } },
    ]) {
      const j = { catalogs: [], impactFactor: 5, name: "J", ...evidence };
      expect(lacksPartitionEvidence(j), JSON.stringify(evidence)).toBe(false);
    }
  });

  it("骑墙刊(both: 既有国际指标又有国内目录)按国内走, 不因缺分区触发", () => {
    const both = { catalogs: ["sci-core"], impactFactor: 4.3, name: "地理科学进展" };
    expect(toJournalKind(both)).toBe("both");
    expect(isDomesticKind("both")).toBe(true);
    expect(lacksPartitionEvidence(both)).toBe(false);
  });

  it("死列 cas_partition 单独一列不能再成为判据(恒真式不许回来)", () => {
    // 整库 0 行, 谁再拿它单独判"缺分区"就是把恒真条件请回来
    expect(SRC).not.toMatch(/!\s*journal\.casPartition\s*\|\|/);
  });

  it("源码确实按 journal_kind 分流, 且分区证据走单一真相源", () => {
    expect(SRC).toContain("isDomesticKind(toJournalKind(journal))");
    expect(SRC).toContain("PARTITION_FACT_KEYS");
  });

  it("国内刊的基础字段仍是富化理由 —— 本轮只摘掉'分区'这一条不成立的理由", () => {
    // 语义说明: needsEnrichment 是"缺任一关键字段即触发"的或链, 分区只是其中一项。
    // 断言 or 链里那几项还在, 防止有人误以为"国内刊不富化了"而顺手删掉。
    for (const field of ["abbreviation", "foundingYear", "website", "coverUrl"]) {
      expect(SRC).toContain(`journal.${field}`);
    }
  });
});
