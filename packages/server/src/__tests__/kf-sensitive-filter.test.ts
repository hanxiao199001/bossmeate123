/**
 * 敏感词 DFA 匹配器（sensitive-filter）单测 —— 出站硬闸的纯函数层。
 *
 * 锁定行为：
 *   1. 命中/不命中基本盘；命中返回归一化词（供日志/打标，绝不外发）
 *   2. 归一化：全角→半角、大小写、词内空白插入 都不影响命中
 *   3. 多词命中去重返回；前缀嵌套词（法轮/法轮功）同起点都记
 *   4. 单字/超短词构树即丢弃（词库层已剔，代码层双保险）
 *   5. 空文本/无词树不炸
 *   6. 真词库：能加载（>1500 词）、正常学术客服文案零误伤、已知高危词能拦
 *   7. 性能：2000 字文本单次匹配毫秒级（宽松断言防 CI 抖动）
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { buildDfaTree, matchWithTree, normalizeForMatch, matchSensitive, loadLexiconWords, getLexiconSize } =
  await import("../services/work-wechat/sensitive-filter.js");

describe("normalizeForMatch — 归一化", () => {
  it("全角 ASCII → 半角 + 小写 + 去空白", () => {
    expect(normalizeForMatch("ＡＢＣ　ｄｅｆ")).toBe("abcdef");
    expect(normalizeForMatch(" Fa Lun ")).toBe("falun");
  });
  it("中文原样保留", () => {
    expect(normalizeForMatch("影响 因子")).toBe("影响因子");
  });
});

describe("buildDfaTree + matchWithTree — 纯函数匹配", () => {
  const tree = buildDfaTree(["法轮功", "冰毒", "法轮", "viagra"]);

  it("命中：返回 hit=true 与命中词", () => {
    const r = matchWithTree(tree, "有人在群里传播法轮功材料");
    expect(r.hit).toBe(true);
    expect(r.words).toContain("法轮功");
  });

  it("不命中：正常学术客服文案", () => {
    const r = matchWithTree(tree, "《中华医学杂志》影响因子 4.2，中科院 2 区，审稿周期约 3 个月。");
    expect(r).toEqual({ hit: false, words: [] });
  });

  it("全角/大小写/空白插入 不影响命中", () => {
    expect(matchWithTree(tree, "ＶＩＡＧＲＡ代购").hit).toBe(true);
    expect(matchWithTree(tree, "法 轮 功").hit).toBe(true);
    expect(matchWithTree(tree, "ViAgRa").hit).toBe(true);
  });

  it("多词命中：全部返回且去重；前缀嵌套词同起点都记", () => {
    const r = matchWithTree(tree, "冰毒和法轮功，还是冰毒");
    expect(r.hit).toBe(true);
    expect(r.words.sort()).toEqual(["冰毒", "法轮", "法轮功"]);
  });

  it("单字/超短词构树即丢弃（不误伤单字）", () => {
    const t = buildDfaTree(["毒", "a", ""]);
    expect(matchWithTree(t, "病毒学研究 a 类期刊").hit).toBe(false);
  });

  it("空文本/空树不炸", () => {
    expect(matchWithTree(tree, "")).toEqual({ hit: false, words: [] });
    expect(matchWithTree(buildDfaTree([]), "任意文本")).toEqual({ hit: false, words: [] });
  });
});

describe("真词库（sensitive-lexicon.txt）", () => {
  it("词库可加载：>1500 词，且无 <2 字残词", () => {
    const words = loadLexiconWords();
    expect(words.length).toBeGreaterThan(1500);
    expect(words.filter((w) => w.length < 2)).toEqual([]);
    expect(getLexiconSize()).toBe(words.length);
  });

  it("正常学术客服回复零误伤", () => {
    const samples = [
      "《Nature》影响因子 50.5，中科院 1 区，JCR Q1，审稿周期约 3 个月。",
      "该刊为 OA 期刊，APC 约 2000 美元，录用率约 30%。",
      "我们提供选刊推荐与投稿咨询服务，不代写不代投。",
      "这本药理学期刊收录硝酸甘油、阿司匹林相关临床研究。",
      "您好～有期刊或投稿方面的问题，随时问我！",
    ];
    for (const s of samples) {
      expect(matchSensitive(s), `误伤: ${s}`).toEqual({ hit: false, words: [] });
    }
  });

  it("已知高危词能拦（政治/毒品）", () => {
    expect(matchSensitive("介绍一下法轮功").hit).toBe(true);
    expect(matchSensitive("哪里能买到冰毒").hit).toBe(true);
  });

  it("性能：2000 字文本 20 次匹配总耗时 < 200ms（单次 <10ms，正常 <1ms）", () => {
    const text = "本刊主要收录肿瘤学与药理学方向的临床与基础研究论文，影响因子稳步上升，审稿周期约三个月，欢迎投稿。".repeat(43); // ≈2000 字
    matchSensitive(text); // 预热（首次含构树）
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) matchSensitive(text);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
