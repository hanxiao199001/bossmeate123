/**
 * 7-14 保底分发: smart-assign 两轮保底分配纯函数 assignArticlesTwoRound 行为单测。
 *   ① 领域够 → 领域配, 每号到 target
 *   ② 领域不足 → 第2轮兜底(放宽学科, 范围严格)补到 target
 *   ③ 池子总量不足 → 雨露均沾 + 报告未达标号(shortfalls)
 *   ④ 一篇一号不破: 同一 articleId 绝不出现在两个号
 *   ⑤ 独家绑定(exclusiveAccountId)直派 + 范围(scope)严格不误发
 */
import { describe, it, expect } from "vitest";
import {
  assignArticlesTwoRound,
  isAdjacentForAccount,
  DISCIPLINE_ADJACENCY,
  type ResolvedArticle,
  type AssignAccountLite,
} from "../services/publisher/smart-assign.js";

const art = (id: string, discipline: string | null, scope: ResolvedArticle["scope"] = null, exclusiveAccountId?: string): ResolvedArticle =>
  ({ id, discipline, scope, exclusiveAccountId });
const acc = (id: string, disciplines: string[], journalScope = "both"): AssignAccountLite =>
  ({ id, disciplines, journalScope });

/** 断言: 一篇一号 — 没有任何 articleId 分给多个号 */
function assertOneArticleOneAccount(pairs: { articleId: string; accountId: string }[]) {
  const seen = new Set<string>();
  for (const p of pairs) {
    expect(seen.has(p.articleId)).toBe(false); // 重复即违反红线
    seen.add(p.articleId);
  }
}
function loadOf(pairs: { accountId: string }[], accountId: string) {
  return pairs.filter((p) => p.accountId === accountId).length;
}

describe("① 领域够 → 领域优先配, 每号到 target", () => {
  it("两个领域号各有充足对口文章 → 各拿满 target=2, 且都是本领域", () => {
    const accounts = [acc("edu", ["education"]), acc("med", ["medicine"])];
    const articles = [
      art("e1", "education"), art("e2", "education"), art("e3", "education"),
      art("m1", "medicine"), art("m2", "medicine"), art("m3", "medicine"),
    ];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "edu")).toBe(2);
    expect(loadOf(pairs, "med")).toBe(2);
    expect(shortfalls).toHaveLength(0);
    // edu 号拿到的都是 education 文章
    for (const p of pairs.filter((x) => x.accountId === "edu")) expect(p.articleId.startsWith("e")).toBe(true);
    assertOneArticleOneAccount(pairs);
  });

  it("不超过 cap: cap=2 时即使文章多也每号最多 2", () => {
    const accounts = [acc("edu", ["education"])];
    const articles = [art("e1", "education"), art("e2", "education"), art("e3", "education"), art("e4", "education")];
    const { pairs } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "edu")).toBe(2);
  });
});

describe("② 领域不足 → 第2轮【相邻学科】兜底补到 target", () => {
  it("本领域文章不足 → 用相邻学科(medicine↔biology)补满 target", () => {
    // med 号领域=medicine, 只有 1 篇 medicine, 但有富余 biology(与 medicine 相邻)
    const accounts = [acc("med", ["medicine"])];
    const articles = [
      art("m1", "medicine"),
      art("b1", "biology"), art("b2", "biology"), // 相邻料, 第2轮兜底
    ];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "med")).toBe(2); // m1(本领域) + 1 篇 biology(相邻兜底)
    expect(shortfalls).toHaveLength(0);
    assertOneArticleOneAccount(pairs);
  });

  it("无关学科宁缺: law 号只有 medicine 剩料(八竿子打不着) → 一篇不塞, 记 shortfall", () => {
    const accounts = [acc("law", ["law"])];
    const articles = [art("med1", "medicine"), art("med2", "medicine")];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "law")).toBe(0); // 医≠法, 不相邻 → 宁缺不硬塞
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]!.accountId).toBe("law");
  });

  it("无学科(null)文章不塞给领域号: med 号只有 null 学科剩料 → shortfall", () => {
    const accounts = [acc("med", ["medicine"])];
    const articles = [art("g1", null), art("g2", null)];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "med")).toBe(0); // 核不出相邻关系 → 领域号宁缺
    expect(shortfalls).toHaveLength(1);
  });

  it("领域不限号: 第2轮可接任意剩余文章(不受相邻限制), 含无学科文", () => {
    const accounts = [acc("open", [])];
    const articles = [art("a1", "law"), art("a2", null)];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "open")).toBe(2); // 不限领域 → law / null 都能收
    expect(shortfalls).toHaveLength(0);
  });

  it("范围仍严格: 国内号不会被国外(international)相邻剩余文章兜底", () => {
    const accounts = [acc("dom", ["medicine"], "domestic")];
    const articles = [art("i1", "biology", "international"), art("i2", "biology", "international")];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "dom")).toBe(0); // 相邻(生↔医)但范围冲突 → 仍不给
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]!.accountId).toBe("dom");
  });
});

describe("③ 池子总量不足 → 雨露均沾 + 报告未达标号", () => {
  it("3 篇 / 5 号 / target=2 → 各号先到 1 篇(不是头几个先满), 全部记 shortfall", () => {
    const accounts = ["a", "b", "c", "d", "e"].map((id) => acc(id, []));
    const articles = [art("x1", null), art("x2", null), art("x3", null)];
    const { pairs, shortfalls } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(pairs).toHaveLength(3);
    // 雨露均沾: 没有任何号拿到 2 篇(应 1-1-1 铺开)
    for (const id of ["a", "b", "c", "d", "e"]) expect(loadOf(pairs, id)).toBeLessThanOrEqual(1);
    // 5 号全部 < target=2 → 全记 shortfall
    expect(shortfalls).toHaveLength(5);
    for (const s of shortfalls) expect(s.target).toBe(2);
    assertOneArticleOneAccount(pairs);
  });
});

describe("④ 一篇一号红线", () => {
  it("大量号 + 少量文章混合领域, 无任何文章被两个号共用", () => {
    const accounts = [acc("edu", ["education"]), acc("med", ["medicine"]), acc("open", [])];
    const articles = [
      art("e1", "education"), art("m1", "medicine"), art("g1", null), art("g2", null),
    ];
    const { pairs } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    assertOneArticleOneAccount(pairs);
    // 分配数不超过文章总数
    expect(pairs.length).toBeLessThanOrEqual(articles.length);
  });
});

describe("⑥ isAdjacentForAccount 相邻判定纯函数", () => {
  it("自身学科命中", () => {
    expect(isAdjacentForAccount(["medicine"], "medicine")).toBe(true);
  });
  it("相邻学科命中(medicine↔biology, education↔psychology)", () => {
    expect(isAdjacentForAccount(["medicine"], "biology")).toBe(true);
    expect(isAdjacentForAccount(["education"], "psychology")).toBe(true);
    expect(isAdjacentForAccount(["economics"], "law")).toBe(true);
  });
  it("无关学科不命中(法↔医)", () => {
    expect(isAdjacentForAccount(["law"], "medicine")).toBe(false);
    expect(isAdjacentForAccount(["education"], "physics")).toBe(false);
  });
  it("领域不限号(空数组)接受任意, 含 null", () => {
    expect(isAdjacentForAccount([], "law")).toBe(true);
    expect(isAdjacentForAccount([], null)).toBe(true);
  });
  it("无学科(null)文章不塞给领域号", () => {
    expect(isAdjacentForAccount(["medicine"], null)).toBe(false);
  });
  it("多领域号: 命中任一偏好的相邻集即可", () => {
    expect(isAdjacentForAccount(["law", "medicine"], "biology")).toBe(true); // 经 medicine 相邻
  });
  it("相邻表对称性抽查", () => {
    expect(DISCIPLINE_ADJACENCY.medicine).toContain("biology");
    expect(DISCIPLINE_ADJACENCY.biology).toContain("medicine");
  });
});

describe("⑤ 独家绑定 + cap", () => {
  it("exclusiveAccountId 文章直派该号, 不被同领域别号抢走", () => {
    const accounts = [acc("locked", ["medicine"]), acc("other", ["medicine"])];
    const articles = [art("bound", "medicine", "international", "locked"), art("free", "medicine", "international")];
    const { pairs } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    const boundPair = pairs.find((p) => p.articleId === "bound");
    expect(boundPair?.accountId).toBe("locked"); // 绑定号直派
    assertOneArticleOneAccount(pairs);
  });

  it("绑定号已达 cap 时, 绑定文章进 unmatched(不越上限)", () => {
    const accounts = [acc("locked", ["medicine"])];
    const articles = [
      art("b1", "medicine", null, "locked"),
      art("b2", "medicine", null, "locked"),
      art("b3", "medicine", null, "locked"), // 第3篇超 cap=2
    ];
    const { pairs, unmatched } = assignArticlesTwoRound({ articles, accounts, target: 2, cap: 2 });
    expect(loadOf(pairs, "locked")).toBe(2);
    expect(unmatched.some((u) => u.articleId === "b3")).toBe(true);
  });
});
