/**
 * `TITLE_PARTITION_CLAIM` 的两向回归锁（8-10）。
 *
 * 这条正则是**生产发布闸**（`findBodyFabrication`）的判据，两个方向的代价不对称：
 *   假阳性 → 误拦合法内容（烦人）
 *   假阴性 → 放过真编造（危险）
 *
 * 所以排除项必须是实测出来的、极窄的。8-10 在 1861 篇存量正文、7685 次命中上
 * 逐字统计后一个字：后跟「别」0 次、后跟「域」1 次、**后跟「分」25 次且全是真断言**。
 * 下面两组断言就是把这个结论钉住 —— 尤其是「分」那一组，防后人"顺手也排掉"。
 */
import { describe, it, expect } from "vitest";

const { TITLE_PARTITION_CLAIM } = await import("../services/compliance/fabrication-criteria.js");

const hit = (s: string) => new RegExp(TITLE_PARTITION_CLAIM.source, TITLE_PARTITION_CLAIM.flags).test(s);

describe("真分区断言必须命中（假阴性方向 —— 放过真编造更危险）", () => {
  it.each([
    "本刊为中科院1区期刊。",
    "JCR Q2 收录。",
    "该刊属于 Q1。",
    "这是一本一区刊物。",
    "生物学3区，新锐分区相同。",
    // 🔴 实测 25 次，全是真断言。曾有人想把「区分」排掉，那会让这三条全部漏网
    "期刊的工程技术3区分类，反映其应用领域认可度。",
    "其生物学1区分区（新锐分区为生物学1区TOP）表明…",
    "工程技术2区分类（新锐分区相同）。",
  ])("「%s」命中", (s) => {
    expect(hit(s)).toBe(true);
  });
});

describe("普通词不许命中（假阳性方向 —— 实测只有这两种形态）", () => {
  it.each([
    "这一区别意味着同一本刊在不同评价体系中的比较范围不同。", // 8-10「学科定位」样例实际踩到
    "该刊聚焦全球尺度的生态保护研究，而非单一区域或纯理论生态学。", // 存量正文唯一那次
    "每一区域都有各自的侧重。",
    "统一区别对待。",
  ])("「%s」不命中", (s) => {
    expect(hit(s)).toBe(false);
  });

  it("排除项**只有**别与域 —— 加第三个之前先去量存量", () => {
    // 这条断言的意义是让"顺手多排一个"变成一次显式的测试修改
    expect(TITLE_PARTITION_CLAIM.source).toContain("(?![别域])");
  });
});
