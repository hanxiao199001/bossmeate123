/**
 * 内容工坊列表按「产出时间」排，不按「最后被改过的时间」（8-20）。
 *
 * ## 实况
 *
 * 原来用 `desc(contents.updatedAt)`。而 `updatedAt` 反映的是
 * 「最后被任何人/任何脚本改过」—— 于是每一次批量运维 UPDATE 都会把那批内容
 * 集体顶到第一页：
 *
 * ```
 * 8-13 摘 placeholder body（10 条）  → 它们的 updatedAt 变成 8-13
 * 8-18 救回被误杀的内容（35 条）      → 变成 8-18
 * 实测第一页前四条: 08-12 生成 / 08-19 改 / archived
 * ```
 *
 * 运营打开列表第一眼看到四条归档旧稿。**而这个洞存在很久没人发现，
 * 因为没有人每天在用这个列表** —— 与背景图闸那次同形态：
 * 功能在那儿、没报错、但没人真在用，所以坏了也没人知道。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../routes/content.ts", import.meta.url), "utf8");

describe("列表排序键", () => {
  /**
   * 🔴 判据绑**就近窗口**（红线 #16）：只看内容列表那一段的 orderBy，
   * 不是"整个文件里有没有 updatedAt"——文件里别处用它是合法的。
   */
  const listBlock = (() => {
    const i = src.indexOf(".from(contents)");
    return src.slice(i, i + 1200);
  })();

  it("默认按 createdAt 排（= 最新产出）", () => {
    expect(listBlock).toMatch(/orderBy\(desc\(contents\.createdAt\)\)/);
  });

  /**
   * 反向锁：这一段里不许再出现按 updatedAt 排序。
   * 「最近编辑」视图要做的话，走显式排序参数，别改默认。
   */
  it("这一段不许再用 updatedAt 排序 —— 运维动作不该改写业务视图顺序", () => {
    expect(listBlock).not.toMatch(/orderBy\(desc\(contents\.updatedAt\)\)/);
  });

  it("注释里留着为什么（免得下次被'优化'回去）", () => {
    const i = src.indexOf("orderBy(desc(contents.createdAt))");
    const before = src.slice(Math.max(0, i - 900), i);
    expect(before).toContain("updatedAt");
    expect(before).toMatch(/运维|批量|改过/);
  });
});
