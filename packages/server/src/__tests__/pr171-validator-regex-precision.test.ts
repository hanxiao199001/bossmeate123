/**
 * PR #171 — Validator regex 精化 + 模糊表述白名单
 *
 * Root cause: extractClaimedFacts IF regex 过贪, 把 "Q1" / "近10年" / SVG 坐标 /
 * 评分 "4/5" 都当 IF 值提取. 10 篇文章 7 warned, 其中 6-7 个是 regex 误判.
 */
import { describe, it, expect } from "vitest";
import { extractClaimedFacts, verifyClaimsAgainstDb } from "../services/skills/ai-content-validator.js";

describe("PR #171: IF regex 精化 — 不再误提 Q1 / 评分 / 近N年", () => {
  it("decimal IF 正常提取 — 'IF 14.7' / '影响因子 2.6'", () => {
    const facts = extractClaimedFacts("这本期刊 IF 14.7, 而某竞品影响因子 2.6");
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(2);
    expect(ifClaims.map((f) => f.claimed as number).sort((a, b) => a - b)).toEqual([2.6, 14.7]);
  });

  it("Q1 分区不误提 — 'Q1 JCR 分区 影响因子 63.1' 只提 63.1", () => {
    const body = "Q1 JCR 分区 最新影响因子 63.1";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(63.1);
  });

  it("评分 '4 / 5' 不误提", () => {
    const body = "推荐指数 ★★☆☆☆ 2 / 5 📈 IF 4.1";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(4.1);
  });

  it("'近10年影响因子' 不误提 10 为 IF", () => {
    const body = "由于缺乏近10年影响因子历史数据，本文基于当前 IF 4.1 的表现分析";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(4.1);
  });

  it("'引用前10期刊' 不误提 10 为 IF", () => {
    const body = "引用前10期刊分布如下。该刊 IF 7.8";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(7.8);
  });

  it("integer IF + '分' 限定符仍提取 — 'IF 7 分'", () => {
    const body = "该刊 IF 7 分，属于医学高分刊";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(7);
  });

  it("纯整数无限定符不提取 — 'IF 63' 后面没有 '分' 不该提取", () => {
    // "IF 63" 没有小数点也没有 "分" → 不提取 (防 SVG 坐标 "IF 63" 残留)
    // 但 "IF 63.1" 有小数点 → 提取
    const body = "分区 IF 63, 而真实 IF 63.1";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(63.1);
  });
});

describe("PR #171: 模糊语境白名单 — 预测/通常/左右 不 warn", () => {
  it("'预测未来IF将维持在60-65区间' — isModalContext 过滤", () => {
    const body = "预测未来2-3年IF 62.0维持在60-65区间，除非出现新的引用爆发点。该期刊目前已确认最新 IF 63.1，是医学领域顶刊。";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    // 只应提取 63.1 (无模糊词), 62.0 被 "预测"/"维持在"/"区间" 过滤
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(63.1);
  });

  it("'APC 通常在 2000-2500 左右' — 模糊语境跳过 apcFee", () => {
    const body = "版面费（APC）：据公开资料尚无统一披露，通常 MDPI 旗下 OA 期刊 APC 在 2000-2500 瑞士法郎左右";
    const facts = extractClaimedFacts(body);
    const apcClaims = facts.filter((f) => f.field === "apcFee");
    expect(apcClaims).toHaveLength(0);
  });

  it("确定性 APC 仍提取 — '版面费 $2900'", () => {
    const body = "版面费 $2900, 需作者自付";
    const facts = extractClaimedFacts(body);
    const apcClaims = facts.filter((f) => f.field === "apcFee");
    expect(apcClaims).toHaveLength(1);
    expect(apcClaims[0]!.claimed).toBe(2900);
  });
});

describe("PR #171: HTML/SVG 深度清洗", () => {
  it("SVG viewBox / rect 坐标不污染提取", () => {
    const svgBody = `<svg viewBox="0 0 600 260"><rect x="50" y="30" width="520"/></svg> 该刊 IF 2.6`;
    const facts = extractClaimedFacts(svgBody);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(2.6);
  });

  it("评分 '★★★☆☆ 4/5' strip 后不误提", () => {
    const body = "★★★☆☆ 4/5 性价比尚可。IF 2.5";
    const facts = extractClaimedFacts(body);
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(1);
    expect(ifClaims[0]!.claimed).toBe(2.5);
  });
});

describe("PR #171: 回归 — 现有正确提取不受影响", () => {
  it("录用率仍正常提取", () => {
    const facts = extractClaimedFacts("Nature 录用率仅 8%, Frontiers 录用率约 48%");
    const accept = facts.filter((f) => f.field === "acceptanceRate");
    expect(accept).toHaveLength(2);
  });

  it("审稿周期仍正常提取", () => {
    const facts = extractClaimedFacts("审稿 5-8 周, 比同行快; 审稿周期 4 周");
    const cycles = facts.filter((f) => f.field === "reviewCycle");
    expect(cycles).toHaveLength(2);
  });

  it("创刊年仍正常提取", () => {
    const facts = extractClaimedFacts("创刊 2010 年, Nature 成立于 1869");
    const years = facts.filter((f) => f.field === "foundingYear");
    expect(years).toHaveLength(2);
  });

  it("出版国仍正常提取", () => {
    const facts = extractClaimedFacts("出版国 瑞士。出版国：英国，发文量大");
    const countries = facts.filter((f) => f.field === "country");
    expect(countries).toHaveLength(2);
  });

  it("HTML strip 后 key/value 仍能跨标签提取", () => {
    const htmlBody = `<p><strong>创刊年：</strong>2010</p><div>IF 2.6</div>`;
    const facts = extractClaimedFacts(htmlBody);
    expect(facts.find((f) => f.field === "foundingYear")?.claimed).toBe(2010);
    expect(facts.find((f) => f.field === "impactFactor")?.claimed).toBe(2.6);
  });
});
