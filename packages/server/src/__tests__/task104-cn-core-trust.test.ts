/**
 * task#104 阶段1: 国内核心目录进 confidence。
 * 北大核心/CSCD核心库 +20(单一即越 70), CSCD扩展库 +10; 仅核心目录=cn_core_verified(语义不同于国际 multi_source);
 * 核心+国际源仍 multi_source_verified; 核心身份 provenance=cscd/pku, IF/分区 provenance 不变(letpub)。
 */
import { describe, it, expect } from "vitest";
import { computeTrust } from "../services/journal-enricher/trust-score.js";

const NO_INTL = { crossref: false, doaj: false, scimago: false, letpub: false };

describe("computeTrust — 国内核心目录信号", () => {
  it("北大核心 only → conf 70(越门槛) + cn_core_verified + provenance pku", () => {
    const r = computeTrust({ ...NO_INTL, pkuCore: true });
    expect(r.confidence).toBe(70);
    expect(r.dataSource).toBe("cn_core_verified");
    expect(r.fieldProvenance.pku_core_level).toBe("pku");
    expect(r.fieldProvenance.if_history).toBeUndefined(); // 无 letpub → IF 无源 → 保持 null
  });

  it("CSCD核心库 only → conf 70 + cn_core_verified + provenance cscd", () => {
    const r = computeTrust({ ...NO_INTL, cscdCore: true });
    expect(r.confidence).toBe(70);
    expect(r.dataSource).toBe("cn_core_verified");
    expect(r.fieldProvenance.cscd_level).toBe("cscd");
  });

  it("CSCD扩展库 only → conf 60(仍未越 70) + cn_core_verified", () => {
    const r = computeTrust({ ...NO_INTL, cscdExtended: true });
    expect(r.confidence).toBe(60);
    expect(r.dataSource).toBe("cn_core_verified");
  });

  it("北大核心 + CSCD核心库 → conf 90(叠加)", () => {
    const r = computeTrust({ ...NO_INTL, pkuCore: true, cscdCore: true });
    expect(r.confidence).toBe(90);
    expect(r.dataSource).toBe("cn_core_verified");
  });

  it("核心库与扩展库互斥: 同传只取核心库 +20(不叠成 +30)", () => {
    const r = computeTrust({ ...NO_INTL, cscdCore: true, cscdExtended: true });
    expect(r.confidence).toBe(70);
  });

  it("北大核心 + letpub → multi_source_verified(核心+国际交叉), IF provenance 仍 letpub", () => {
    const r = computeTrust({ ...NO_INTL, letpub: true, pkuCore: true });
    expect(r.confidence).toBe(90); // 50+20(letpub)+20(核心)
    expect(r.dataSource).toBe("multi_source_verified"); // 不混用: 核心+国际 → multi_source
    expect(r.fieldProvenance.if_history).toBe("letpub"); // 数值仍 letpub
    expect(r.fieldProvenance.pku_core_level).toBe("pku"); // 身份 pku
  });

  it("无核心无国际 → conf 50 + dataSource null(不强写)", () => {
    const r = computeTrust(NO_INTL);
    expect(r.confidence).toBe(50);
    expect(r.dataSource).toBeNull();
  });

  it("回归: crossref only(无核心) → 70 + multi_source_verified 不变", () => {
    const r = computeTrust({ crossref: true, doaj: false, scimago: false, letpub: false });
    expect(r.confidence).toBe(70);
    expect(r.dataSource).toBe("multi_source_verified");
  });

  it("回归: 仅 letpub → letpub_only 不变", () => {
    const r = computeTrust({ ...NO_INTL, letpub: true });
    expect(r.dataSource).toBe("letpub_only");
  });
});

describe("客服 journalFacts surface 核心身份(供播报'北大核心'但不编 IF)", () => {
  it("journalFacts 含'国内核心目录'行(pku/cscd), 且 IF 仍走 null→暂无数据", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/work-wechat/kf-responder.ts", import.meta.url), "utf8");
    expect(src).toMatch(/国内核心目录:/);
    expect(src).toMatch(/北大核心/);
    expect(src).toMatch(/CSCD \$\{j\.cscdLevel\}/);
    // IF 行不变(核心身份不影响 IF 数值播报护栏)
    expect(src).toMatch(/影响因子\(IF\): \$\{j\.impactFactor \?\? na\}/);
  });
});
