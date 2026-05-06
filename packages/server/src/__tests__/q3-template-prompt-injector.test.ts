/**
 * PR Q.3：纯逻辑复刻测试（PR B.12 范式）— 不导入真模块以避免 db.ts → env.ts 加载链。
 * 复刻 template-prompt-injector.ts 和 few-shot-retrieval.ts 的纯函数，断言 4 套差异化输出。
 */
import { describe, it, expect } from "vitest";

// ============ 纯函数复刻（与 template-prompt-injector.ts 同步）============

const TONE_DESC: Record<string, string> = {
  long: "段落较长，逻辑紧凑，每段 80-150 字",
  short: "段落极短，每段 1-3 句，强冲击",
  medium: "段落适中，每段 40-80 字",
};
const EMOJI_DESC: Record<string, string> = {
  none: "全文不使用任何 emoji 或装饰符号",
  heavy: "标题与段首大量使用 emoji（每段至少 1 个）",
  moderate: "适度使用 emoji（标题可 1-2 个，正文偶尔点缀）",
  sparse: "仅在关键数据点旁使用 emoji 强调（最多 3 处）",
};
const EMPHASIS_DESC: Record<string, string> = {
  low: "数据用普通字号，不加粗",
  medium: "关键数据加粗，标准字号",
  high: "关键数据加粗 + 颜色突出",
  extreme: "关键数据用 H2 大字号 + 颜色 + 加粗",
};

function buildPromptOverrideSuffix(t: { promptOverrides: any; structureJson: any; styleTag: string; displayName: string }): string {
  const po = t.promptOverrides ?? {};
  const sj = t.structureJson ?? {};
  const lines = [`\n## 模板风格约束（${t.displayName} · ${t.styleTag}）`];
  if (po.tone) lines.push(`- 整体语气：${po.tone}`);
  if (po.sentence_length) lines.push(`- 段落长度：${TONE_DESC[po.sentence_length] ?? po.sentence_length}`);
  if (po.emoji_use) lines.push(`- emoji 使用：${EMOJI_DESC[po.emoji_use] ?? po.emoji_use}`);
  if (po.number_emphasis) lines.push(`- 数据强调：${EMPHASIS_DESC[po.number_emphasis] ?? po.number_emphasis}`);
  if (sj.hook_style) lines.push(`- 开头风格（hook）：${sj.hook_style}`);
  if (sj.cta_style) lines.push(`- 结尾召唤（CTA）：${sj.cta_style}`);
  return lines.join("\n");
}

function formatSamplesForPrompt(samples: Array<{ title: string; bodySnippet: string; sourceAccount: string; styleTag: string; score: number }>): string {
  if (samples.length === 0) return "";
  const lines = samples.map((s, i) =>
    `### 样板 ${i + 1}（来源：${s.sourceAccount} · 风格：${s.styleTag} · 相似度 ${(s.score * 100).toFixed(0)}%）\n`
    + `标题：${s.title}\n首段：${s.bodySnippet}\n`,
  );
  return `\n## 行业样板参考（请借鉴语气，不复制内容）\n${lines.join("\n")}`;
}

// ============ 测试 ============

describe("PR Q.3: buildPromptOverrideSuffix（4 套 prompt 风格分化）", () => {
  it("A 学术权威 → 长段落 + 无 emoji + 高强调 + data_first hook", () => {
    const s = buildPromptOverrideSuffix({
      promptOverrides: { tone: "学术严谨", sentence_length: "long", emoji_use: "none", number_emphasis: "high" },
      structureJson: { hook_style: "data_first", cta_style: "sales_assistant" },
      styleTag: "academic", displayName: "学术权威",
    });
    expect(s).toContain("学术权威");
    expect(s).toContain("段落较长");
    expect(s).toContain("不使用任何 emoji");
    expect(s).toContain("data_first");
  });

  it("B 营销转化 → 短段落 + heavy emoji + extreme + shocking_number", () => {
    const s = buildPromptOverrideSuffix({
      promptOverrides: { tone: "营销破圈", sentence_length: "short", emoji_use: "heavy", number_emphasis: "extreme" },
      structureJson: { hook_style: "shocking_number", cta_style: "limited_offer" },
      styleTag: "marketing", displayName: "营销转化",
    });
    expect(s).toContain("段落极短");
    expect(s).toContain("大量使用 emoji");
    expect(s).toContain("H2 大字号");
    expect(s).toContain("shocking_number");
  });

  it("C/E 各自风格不冲突", () => {
    const c = buildPromptOverrideSuffix({
      promptOverrides: { sentence_length: "medium", emoji_use: "moderate" },
      structureJson: { hook_style: "story" },
      styleTag: "popular", displayName: "科普轻松",
    });
    const e = buildPromptOverrideSuffix({
      promptOverrides: { sentence_length: "medium", emoji_use: "sparse" },
      structureJson: { hook_style: "industry_insight" },
      styleTag: "vertical", displayName: "行业垂直",
    });
    expect(c).toContain("适度使用"); expect(c).not.toContain("industry_insight");
    expect(e).toContain("仅在关键数据点旁"); expect(e).not.toContain("story");
  });
});

describe("PR Q.3: formatSamplesForPrompt", () => {
  it("0 样本 → 空字符串", () => {
    expect(formatSamplesForPrompt([])).toBe("");
  });

  it("3 样本 → 含来源 / 风格 / 相似度 / 借鉴指令", () => {
    const out = formatSamplesForPrompt([
      { title: "柳叶刀 IF 趋势", bodySnippet: "近 5 年涨 30%", sourceAccount: "丁香园", styleTag: "popular", score: 0.85 },
      { title: "NEJM 投稿", bodySnippet: "录用率 5%", sourceAccount: "医学界", styleTag: "popular", score: 0.72 },
      { title: "顶刊横评", bodySnippet: "性价比", sourceAccount: "Editage 意得辑", styleTag: "academic", score: 0.61 },
    ]);
    expect(out).toContain("行业样板参考");
    expect(out).toContain("来源：丁香园");
    expect(out).toContain("85%");
    expect(out).toContain("Editage 意得辑");
    expect(out).toContain("借鉴语气，不复制内容");
  });
});

describe("PR Q.3: chat send schema 接 templateId（grep 防回归）", () => {
  it("routes/chat.ts sendMessageSchema 含 templateId optional + body 透传", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/chat.ts", import.meta.url), "utf8");
    expect(src).toMatch(/templateId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(src).toMatch(/templateId:\s*body\.templateId/);
  });
});
