/**
 * 模板轮换判据的**唯一归宿**（8-13 收口）。
 *
 * ## 收口前的病
 *
 * 两处各判各的：
 *   · `article-skill` → `pickRotatingTemplateId()`，从**全部已注册模板**里挑
 *   · `daily-cron`    → 本地 `LAYOUT_TEMPLATES` 白名单（PR-Q7）
 * PR-Q7 那条限制**只管住了 daily-cron**；近 14 天 130 篇
 * popular-science / industry-vertical / data-card 全部从 article-skill 那条链路出来。
 * 在任一处关掉一个模板，另一处随时把它捞回来 —— 老板 8-13 下线 listicle 时点破的正是这个。
 */
import { describe, it, expect } from "vitest";

const reg = await import("../services/skills/template-registry.js");

describe("① listicle 已下线：轮换 1000 次一次都不出现", () => {
  it("pickRotatingTemplateId 1000 次，listicle 出现 0 次", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const id = reg.pickRotatingTemplateId();
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    expect(seen.get("listicle") ?? 0).toBe(0);
    // 防过度收紧：别修成"只剩一个模板"
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("但注册仍在 —— 存量 44 篇的详情页/编辑/重渲染要 getTemplate 非空", () => {
    const t = reg.getTemplate("listicle");
    expect(t).not.toBeNull();
    expect(typeof t!.htmlGenerator).toBe("function");
  });

  it("listRotatableTemplates 不含 listicle，listTemplates 含", () => {
    expect(reg.listRotatableTemplates().map((t) => t.id)).not.toContain("listicle");
    expect(reg.listTemplates().map((t) => t.id)).toContain("listicle");
  });
});

describe("② 关闭必须带依据：reason / date / by 三件套", () => {
  /**
   * PR-Q7 的「有硬伤，修好再放回」写了两个月没人知道修好没 ——
   * 没有日期与依据的关闭，就是下一条没人敢动的过期注释。
   */
  it("每个 rotationEnabled:false 都必须有 rotationDisabled 三件套", () => {
    const disabled = reg.listTemplates().filter((t) => t.rotationEnabled === false);
    expect(disabled.length).toBeGreaterThan(0); // 当前至少 listicle
    for (const t of disabled) {
      expect(t.rotationDisabled, `${t.id} 关了轮换却没写依据`).toBeTruthy();
      expect(t.rotationDisabled!.reason.length).toBeGreaterThan(6);
      expect(t.rotationDisabled!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.rotationDisabled!.by.length).toBeGreaterThan(1);
    }
  });
});

describe("③ 扫描守卫：不许再出现第二处模板随机挑选", () => {
  /**
   * 收口的意义在于**保持**唯一。这条守卫拦的是"下次有人又在别处写一个随机挑模板"。
   * 判据刻意窄：只认「对模板集合做随机下标/随机权重」的形态，不误伤普通随机。
   */
  it("全仓只有 template-registry 一处对模板集合做随机挑选", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = new URL("../", import.meta.url).pathname;
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === "__tests__" || e.name === "node_modules" || e.name === "dist") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    await walk(root);

    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith("template-registry.ts")) continue; // 唯一合法实现
      const src = await readFile(f, "utf-8");
      // 形态：本地写死一组模板 id 常量（含连字符的模板名 ≥2 个并列）后跟随机挑选
      const localList = /\[\s*"(?:shunshi-style|storytelling|listicle|data-card|popular-science|industry-vertical)"\s*,\s*"[a-z-]+"/.test(src);
      const randomPick = /Math\.random\(\)/.test(src);
      if (localList && randomPick) offenders.push(f.replace(root, ""));
    }
    expect(offenders, `这些文件自建了模板随机挑选，应改用 listRotatableTemplates()：\n${offenders.join("\n")}`).toEqual([]);
  });
});
