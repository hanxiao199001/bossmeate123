import { describe, it, expect } from "vitest";
import { findBodyFabrication } from "../services/compliance/content-check.js";

/**
 * 7-21 发布前编造硬闸 —— "prompt降低 + 确定性兜底"里的确定性那半。
 *
 * checkBodyFabricationForPublish 自查库(需 DB), 单测只覆盖它的两块纯逻辑:
 *   ① 骑墙豁免判定(含 sci-core → 不查) ② 底层 findBodyFabrication 的判据。
 * 硬闸的 DB 查询 + 拦截落库由集成路径(draft-distributor/publishToAccounts)承担, 已在服务器真机验证。
 */

// 复刻硬闸里的骑墙豁免判定(与 content-check.ts 的 CN_CORE_TAGS_GATE 同源)
const CN_CORE = ["pku-core", "cssci", "cssci-ext", "cscd"];
const isPureDomesticForGate = (cats: string[]) =>
  cats.some((c) => CN_CORE.includes(c)) && !cats.includes("sci-core");

describe("发布硬闸: 骑墙豁免范围", () => {
  it("纯国内刊(北大核心) → 受硬闸管", () => {
    expect(isPureDomesticForGate(["pku-core", "cssci"])).toBe(true);
  });
  it("🚫 骑墙刊(含 sci-core) → 豁免, 不受硬闸(避免误挡 enrichment 有据的分区, backlog-C)", () => {
    expect(isPureDomesticForGate(["pku-core", "cssci", "cscd", "sci-core"])).toBe(false);
  });
  it("纯国际刊(仅 sci-core) → 不受硬闸", () => {
    expect(isPureDomesticForGate(["sci-core"])).toBe(false);
  });
  it("无核心标签 → 不受硬闸", () => {
    expect(isPureDomesticForGate([])).toBe(false);
  });
});

describe("发布硬闸: 底层编造判据(纯国内刊 DB 无 IF/分区)", () => {
  const DOMESTIC_EMPTY = {
    impactFactor: null, compositeImpactFactor: null,
    partition: null, casPartition: null, casPartitionNew: null, jcrFull: null,
  };

  it("正文编 '1区' → 命中(该拦)", () => {
    const hits = findBodyFabrication("<p>该刊属于农林科学1区，认可度高。</p>", DOMESTIC_EMPTY);
    expect(hits.some((h) => h.includes("DB无分区"))).toBe(true);
  });

  it("正文编 'IF 3.456' → 命中(华南农业实例)", () => {
    const hits = findBodyFabrication("<p>2023年影响因子3.456，表现突出。</p>", DOMESTIC_EMPTY);
    expect(hits.some((h) => h.includes("DB无影响因子"))).toBe(true);
  });

  it("正文只讲身份/学科, 无 IF/分区 → 放行(改动3 的合格国内刊文)", () => {
    const hits = findBodyFabrication(
      "<p>这本北大核心+CSSCI来源期刊，农业经济方向对口，评职称硬通货。</p>",
      DOMESTIC_EMPTY,
    );
    expect(hits).toHaveLength(0);
  });

  it("骑墙刊有真分区(enrichment 填了 casPartitionNew) → 正文写分区不算编造", () => {
    const hits = findBodyFabrication("<p>中科院2区，材料方向。</p>", { ...DOMESTIC_EMPTY, casPartitionNew: "2区" });
    expect(hits.some((h) => h.includes("分区"))).toBe(false);
  });
});
