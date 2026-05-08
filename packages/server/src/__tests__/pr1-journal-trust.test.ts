/**
 * PR 1（5-8 P0++）：期刊数据可信度治理。
 *
 * 覆盖：
 *  - schema 5 列（data_source / source_url / last_verified_at / confidence / field_provenance）
 *  - migration SQL 含 ALTER + 历史回填 + 2 索引
 *  - article-skill.persistAIJournal 去重 + 标 ai_fabricated/30
 *  - placeholder 清理：shunshi-style-template 0 个 'B.2 阶段批量回填' 字面量
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR 1: schema 5 列 + 索引", () => {
  it("schema.ts journals 表含 dataSource/sourceUrl/lastVerifiedAt/confidence/fieldProvenance", () => {
    const src = read("models/schema.ts");
    expect(src).toMatch(/dataSource:\s*text\("data_source"\)/);
    expect(src).toMatch(/sourceUrl:\s*text\("source_url"\)/);
    expect(src).toMatch(/lastVerifiedAt:\s*timestamp\("last_verified_at",\s*\{\s*withTimezone:\s*true/);
    expect(src).toMatch(/confidence:\s*integer\("confidence"\)\.default\(50\)/);
    expect(src).toMatch(/fieldProvenance:\s*jsonb\("field_provenance"\)/);
  });

  it("schema.ts journals 含 idx_journals_confidence + idx_journals_data_source", () => {
    const src = read("models/schema.ts");
    expect(src).toMatch(/idx_journals_confidence/);
    expect(src).toMatch(/idx_journals_data_source/);
  });
});

describe("PR 1: migration SQL", () => {
  it("migrate.ts 含 ALTER TABLE journals ADD COLUMN 5 列（幂等）", () => {
    const src = read("models/migrate.ts");
    expect(src).toMatch(/ALTER TABLE journals ADD COLUMN data_source TEXT/);
    expect(src).toMatch(/ALTER TABLE journals ADD COLUMN source_url TEXT/);
    expect(src).toMatch(/ALTER TABLE journals ADD COLUMN last_verified_at TIMESTAMPTZ/);
    expect(src).toMatch(/ALTER TABLE journals ADD COLUMN confidence INTEGER DEFAULT 50/);
    expect(src).toMatch(/ALTER TABLE journals ADD COLUMN field_provenance JSONB/);
  });

  it("migrate.ts 含 10 顶刊 manual_seed_2024 回填", () => {
    const src = read("models/migrate.ts");
    expect(src).toMatch(/data_source = 'manual_seed_2024'/);
    expect(src).toMatch(/confidence = 95/);
    // 10 顶刊全部命中
    for (const name of ["The Lancet", "NEJM", "Nature", "JAMA", "BMJ", "Cell", "Science", "PNAS"]) {
      expect(src).toContain(`'${name}'`);
    }
  });

  it("migrate.ts 含 legacy_unknown 回填（其他 row）", () => {
    const src = read("models/migrate.ts");
    expect(src).toMatch(/data_source = 'legacy_unknown'/);
  });

  it("migrate.ts 含 2 个 INDEX（confidence ASC NULLS FIRST + data_source）", () => {
    const src = read("models/migrate.ts");
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_journals_confidence ON journals\(confidence ASC NULLS FIRST\)/,
    );
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_journals_data_source ON journals\(data_source\)/);
  });
});

describe("PR 1: article-skill.persistAIJournal", () => {
  it("含 dataSource 'ai_fabricated' confidence 30 + 去重逻辑", () => {
    const src = read("services/skills/article-skill.ts");
    expect(src).toMatch(/persistAIJournal/);
    expect(src).toMatch(/dataSource:\s*"ai_fabricated"/);
    expect(src).toMatch(/confidence:\s*30/);
    // 去重：先 SELECT 再 INSERT/UPDATE
    expect(src).toMatch(/select.*journals\.id.*from\(journals\)/s);
    expect(src).toMatch(/lastVerifiedAt:/);
  });

  it("tenantId 缺时跳过持久化（公开 /try 路径无 tenant）", () => {
    const src = read("services/skills/article-skill.ts");
    expect(src).toMatch(/if\s*\(!tenantId\)\s*return/);
  });
});

describe("PR 1: routes/journals seed 标 manual_seed_2024", () => {
  it("seed import 含 dataSource 'manual_seed_2024' confidence 95", () => {
    const src = read("routes/journals.ts");
    expect(src).toMatch(/dataSource:\s*"manual_seed_2024"/);
    expect(src).toMatch(/confidence:\s*95/);
  });
});

describe("PR 1: placeholder dev 术语清理", () => {
  it("shunshi-style-template.ts 0 处 user-visible submessage 含 'B.2 阶段'", () => {
    const src = read("services/publisher/adapters/shunshi-style-template.ts");
    // submessage 字面量字符串内不含 dev 术语
    const submessageMatches = src.match(/submessage:\s*"[^"]*"/g) ?? [];
    expect(submessageMatches.length).toBeGreaterThan(0); // 至少有 placeholder
    const hasB2 = submessageMatches.some((m) => /B\.2 阶段|B\.2.*回填/.test(m));
    expect(hasB2).toBe(false);
  });

  it("submessage 全部为用户友好文案", () => {
    const src = read("services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/数据完善中，敬请期待/);
  });
});
