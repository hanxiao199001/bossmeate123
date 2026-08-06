/**
 * 数据供给分级 —— 判据锁定 + 旁路扫描守卫（8-06 P0-A1）。
 *
 * 背景: 8-05 取样 5 篇「DB 无 IF」的内容, **5/5 全部叙述型编造**（"审稿流程严谨"
 * "实证研究稿件更受青睐", DB 里一个字没有）。病根是任务无解 —— 模板固定要写投稿指南,
 * 而这本刊除了名字什么都没有。所以体裁应由数据供给决定。
 *
 * 本文件锁两件:
 *   ① 分级判据本身（含"数据缺席"分支 —— 这正是 tier1-failopen-gates 21 个用例都没覆盖的那类）
 *   ② 禁止别处手写旁路判据（判据分叉这个项目已经栽过多次）
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const {
  classifyDataSupply, supplyPromptConstraints, supplyMetadata,
} = await import("../services/journals/journal-data-supply.js");

const RICH = { impactFactor: 3.2, partition: "Q1", reviewCycle: "8-12周", catalogs: ["sci"] };
const MEDIUM = { impactFactor: 3.2, partition: "Q1", catalogs: ["sci"] };
const SPARSE = { catalogs: ["cssci"], disciplineCode: "education", publisher: "某某大学" };

describe("分级判据", () => {
  it("有指标 + 有流程数据 → rich", () => {
    expect(classifyDataSupply(RICH).level).toBe("rich");
  });

  it("有指标但无审稿周期/录用率 → medium(流程板块不得出现)", () => {
    expect(classifyDataSupply(MEDIUM).level).toBe("medium");
    expect(classifyDataSupply(MEDIUM).reason).toContain("流程");
  });

  it("🔴 只有刊名/目录/学科 → sparse(实测占近六成)", () => {
    expect(classifyDataSupply(SPARSE).level).toBe("sparse");
  });

  it("国内刊只有复合影响因子也算有指标(compositeImpactFactor)", () => {
    expect(classifyDataSupply({ compositeImpactFactor: 1.2, reviewCycle: "6周" }).level).toBe("rich");
  });

  it("中科院新锐分区单独也算有分区(casPartitionNew)", () => {
    expect(classifyDataSupply({ casPartitionNew: "医学1区TOP" }).level).toBe("medium");
  });

  it("录用率单独也能构成流程数据", () => {
    expect(classifyDataSupply({ impactFactor: 2, acceptanceRate: 0.18 }).level).toBe("rich");
  });

  // ===== 数据缺席分支 =====
  it("🔴 期刊为 null → sparse, 且 reason 说明是「没有关联期刊」(与「有刊但没数据」要能区分)", () => {
    const s = classifyDataSupply(null);
    expect(s.level).toBe("sparse");
    expect(s.reason).toContain("没有关联期刊");
    expect(Object.values(s.has).every((v) => v === false)).toBe(true);
  });

  it("空对象 → sparse, 不抛错", () => {
    expect(classifyDataSupply({}).level).toBe("sparse");
  });

  it("catalogs 为空数组不算有目录(别把空数组当成有数据)", () => {
    expect(classifyDataSupply({ catalogs: [] }).has.catalog).toBe(false);
  });

  it("cscdLevel / pkuCoreLevel 单独也构成目录成员资格", () => {
    expect(classifyDataSupply({ pkuCoreLevel: "北大核心" }).has.catalog).toBe(true);
  });

  it("⚠️ 空串当前会被判成「有数据」(hasDbFact 语义) —— 锁住这个已知前提, 变了要有人知道", () => {
    // 线上实测这些列空串 = 0 行(8-06)。若哪天写入侧写回空串, 这条会先红。
    expect(classifyDataSupply({ partition: "" }).has.partition).toBe(true);
  });
});

describe("prompt 禁令(治叙述型编造)", () => {
  it("🔴 无流程数据 → 必须显式禁止审稿流程类叙述, 且点名那几句实际编过的话", () => {
    const c = supplyPromptConstraints(classifyDataSupply(MEDIUM)).join("\n");
    expect(c).toContain("严禁");
    expect(c).toContain("审稿流程严谨");   // 8-05 实际编造样本里的原话
    expect(c).toContain("实证研究稿件更受青睐");
  });

  it("无 IF → 禁数值也禁形容替代(光禁数字不够, 会改写成「影响因子较高」)", () => {
    const c = supplyPromptConstraints(classifyDataSupply(SPARSE)).join("\n");
    expect(c).toContain("影响因子");
    expect(c).toMatch(/形容|较高/);
  });

  it("rich 不加多余禁令(有据可写就别捆住手脚)", () => {
    expect(supplyPromptConstraints(classifyDataSupply(RICH))).toHaveLength(0);
  });

  it("sparse 额外限定「只能基于已给出的事实」", () => {
    const c = supplyPromptConstraints(classifyDataSupply(SPARSE)).join("\n");
    expect(c).toContain("不得引入任何未在数据块中出现");
  });
});

describe("metadata 形态", () => {
  it("落库字段带等级 + 人话原因 + 明细(排查时能一眼看出为什么判 sparse)", () => {
    const m = supplyMetadata(classifyDataSupply(SPARSE));
    expect(m.dataSupply).toBe("sparse");
    expect(typeof m.dataSupplyReason).toBe("string");
    expect(m.dataSupplyHas).toBeTruthy();
  });
});

// ============ 扫描守卫: 禁止旁路判据 ============

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
function collect(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "__tests__" || n === "node_modules") continue;
    const p = resolve(dir, n);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * 白名单 —— 加进来必须写明为什么这里手写是对的。
 * 判据的唯一归宿是 journal-data-supply.ts; 其余地方要问「这本刊数据够不够」一律 import。
 */
const ALLOW: Record<string, string> = {
  "services/journals/journal-data-supply.ts": "判据本身就定义在这里",
  "services/compliance/fabrication-criteria.ts": "hasDbFact 的定义处, 是本判据的底层依赖",
};

describe("扫描守卫: 数据供给判据不许分叉", () => {
  it("🔴 别处不得手写「有没有 IF/分区」的组合判据 —— 一律走 classifyDataSupply", () => {
    // 只抓「同时判 IF 和分区」的组合形态(单独读某个字段渲染是正常的, 不拦)
    const pattern =
      /(impactFactor|impact_factor)[\s\S]{0,80}(compositeImpactFactor|composite_impact_factor)[\s\S]{0,120}(partition|casPartitionNew)/;
    const hits: string[] = [];
    for (const f of collect(SRC)) {
      const rel = relative(SRC, f);
      if (ALLOW[rel]) continue;
      const src = readFileSync(f, "utf8");
      // 去掉注释行再匹配, 免得文档里举例也被当违规
      const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      if (pattern.test(code)) hits.push(rel);
    }
    expect(
      hits,
      `发现 ${hits.length} 处疑似手写数据供给判据。判据唯一归宿是 journal-data-supply.ts ——\n` +
      `这个项目已经因为判据分叉栽过多次(见 intl-signal.ts 文件头)。\n` +
      `确实需要手写请加进 ALLOW 并写明理由。\n  ${hits.join("\n  ")}`,
    ).toEqual([]);
  });
});
