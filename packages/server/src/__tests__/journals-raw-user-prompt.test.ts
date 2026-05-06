/**
 * PR B.13：rawUserPrompt 候选词生成纯逻辑复刻测试。
 * 复刻 collector.ts:248+ 把 rawUserPrompt 拆成 ISSN / 完整 / 去括号 / token 候选喂进
 * journalConds 的逻辑，验证 5-2/5-5 false alarm 真实 prompt 都能产出能命中 DB 的候选。
 */
import { describe, it, expect } from "vitest";

interface Candidates { issn: string | null; names: string[] }
function buildRawPromptCandidates(rawPrompt: string | undefined, topic: string): Candidates {
  const out: Candidates = { issn: null, names: [] };
  if (!rawPrompt || rawPrompt === topic) return out;
  const rawIssn = rawPrompt.match(/\b\d{4}-\d{3}[\dxX]\b/);
  if (rawIssn) out.issn = rawIssn[0];
  out.names.push(rawPrompt);
  const rawCleaned = rawPrompt.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
  if (rawCleaned && rawCleaned !== rawPrompt) out.names.push(rawCleaned);
  for (const tok of rawCleaned.split(/\s+/).filter((t) => t.length >= 2 && t !== rawCleaned)) {
    out.names.push(tok);
  }
  return out;
}

describe("PR B.13: rawUserPrompt 候选词生成", () => {
  it('rawPrompt="The Lancet" + topic="医学顶刊" → "The Lancet" 与 token "Lancet" 都进候选', () => {
    const r = buildRawPromptCandidates("The Lancet", "医学顶刊");
    expect(r.names).toContain("The Lancet");
    expect(r.names).toContain("Lancet");
    expect(r.issn).toBeNull();
  });

  it('rawPrompt="新英格兰医学杂志" + topic 不同 → 完整中文名进候选可命中 name 字段', () => {
    const r = buildRawPromptCandidates("新英格兰医学杂志", "医学顶刊IF 91.2");
    expect(r.names).toContain("新英格兰医学杂志");
  });

  it('rawPrompt="0140-6736" → ISSN 解析正确', () => {
    const r = buildRawPromptCandidates("0140-6736", "医学顶刊");
    expect(r.issn).toBe("0140-6736");
  });

  it("noop 双场景：rawPrompt 为空 / rawPrompt === topic（避免与 PR B.11 主路径重复）", () => {
    expect(buildRawPromptCandidates(undefined, "x")).toEqual({ issn: null, names: [] });
    expect(buildRawPromptCandidates("foo bar", "foo bar")).toEqual({ issn: null, names: [] });
  });
});
