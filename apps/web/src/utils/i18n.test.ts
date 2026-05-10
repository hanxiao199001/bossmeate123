/** PR #124 i18n mapping 单测：保证 6 enum × 4 表 × 兜底逻辑全 OK。 */
import { describe, it, expect } from "vitest";
import {
  dataSourceLabel,
  articleStatusLabel,
  batchRowStatusLabel,
  batchStatusLabel,
  journalAuditFieldLabel,
  labelOr,
} from "./i18n";

describe("dataSourceLabel — journals.data_source 6 enum", () => {
  it("覆盖全 6 个 DB enum 值，无遗漏", () => {
    const expected = [
      "multi_source_verified",
      "manual_seed_2024",
      "letpub_only",
      "token_fuzzy",
      "ai_fabricated",
      "legacy_unknown",
    ];
    for (const k of expected) expect(dataSourceLabel[k]).toBeTruthy();
  });

  it("中文 + emoji 装饰", () => {
    expect(dataSourceLabel.multi_source_verified).toBe("✅ 多源核验");
    expect(dataSourceLabel.manual_seed_2024).toBe("✅ 手动录入");
    expect(dataSourceLabel.letpub_only).toBe("📚 单源 LetPub");
    expect(dataSourceLabel.token_fuzzy).toBe("🟡 模糊匹配");
    expect(dataSourceLabel.ai_fabricated).toBe("⚠️ AI 编造");
    expect(dataSourceLabel.legacy_unknown).toBe("❓ 从未验证");
  });
});

describe("articleStatusLabel — contents.status P0 6 状态机", () => {
  it("覆盖 P0 spec 全 6 状态", () => {
    expect(articleStatusLabel.draft).toBe("草稿");
    expect(articleStatusLabel.generating).toBe("生成中");
    expect(articleStatusLabel.generated).toBe("已生成");
    expect(articleStatusLabel.published).toBe("已发布");
    expect(articleStatusLabel.failed).toBe("失败");
    expect(articleStatusLabel.archived).toBe("归档");
  });
});

describe("batchRowStatusLabel — batch_rows.status 4 状态", () => {
  it("覆盖 P4 spec 全 4 状态", () => {
    expect(batchRowStatusLabel.pending).toBe("等待中");
    expect(batchRowStatusLabel.generating).toBe("生成中");
    expect(batchRowStatusLabel.generated).toBe("已生成");
    expect(batchRowStatusLabel.failed).toBe("失败");
  });
});

describe("batchStatusLabel — batches.status 5 状态", () => {
  it("覆盖 batch 顶层 5 状态", () => {
    expect(batchStatusLabel.pending).toBe("待处理");
    expect(batchStatusLabel.running).toBe("进行中");
    expect(batchStatusLabel.completed).toBe("已完成");
    expect(batchStatusLabel.failed).toBe("已失败");
    expect(batchStatusLabel.cancelled).toBe("已取消");
  });
});

describe("journalAuditFieldLabel — audit 页 column header", () => {
  it("4 字段中文 + last_verified_at/last_verified 双别名", () => {
    expect(journalAuditFieldLabel.data_source).toBe("数据来源");
    expect(journalAuditFieldLabel.confidence).toBe("可信度");
    expect(journalAuditFieldLabel.source_url).toBe("数据源验证");
    expect(journalAuditFieldLabel.last_verified).toBe("最后验证");
    expect(journalAuditFieldLabel.last_verified_at).toBe("最后验证");
  });
});

describe("labelOr — 兜底", () => {
  it("已知 key 返中文 label", () => {
    expect(labelOr(dataSourceLabel, "ai_fabricated")).toBe("⚠️ AI 编造");
  });

  it("未知 key 返原值（不返 undefined / 空白）", () => {
    expect(labelOr(dataSourceLabel, "unknown_new_enum")).toBe("unknown_new_enum");
  });

  it("null/undefined 返 em-dash 占位", () => {
    expect(labelOr(dataSourceLabel, null)).toBe("—");
    expect(labelOr(dataSourceLabel, undefined)).toBe("—");
  });
});
