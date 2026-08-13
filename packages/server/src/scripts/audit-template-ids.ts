/**
 * templateId 合法性审计（8-13）。**只读**，加 --apply 才修正。
 *
 * 守卫先行（红线 #17）：本脚本先落地并**报红**，红的条数就是待收口清单；
 * 收口做完它应当归零。一开始就绿 = 判据写错了地方。
 *
 * 预期首次报红 106 条：
 *   · 103 条虚构模板名（popular-science 52 / industry-vertical 51）—— 实际由 shunshi-style 渲染
 *   ·   3 条 templateId="A"（人设字母直接漏进了模板字段，且 3 条都 failed）
 */
import { and, eq, gte } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { isRegisteredTemplateId, listTemplates, DEFAULT_TEMPLATE_ID } from "../services/skills/template-registry.js";

const APPLY = process.argv.includes("--apply");
/** 数字人主播人设字母 —— 它属于 personaLetter，不是渲染模板 */
const PERSONA_LETTERS = new Set(["A", "B", "C", "E"]);
/** 由人设字母伪造出来的模板名 → 它们从来没有实现，实际都 fallback 到默认模板 */
const FAKE_FROM_LETTER: Record<string, string> = {
  "marketing-conversion": "B",
  "popular-science": "C",
  "industry-vertical": "E",
};

async function main() {
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const rows = await db.select().from(contents).where(and(eq(contents.type, "article"), gte(contents.createdAt, since)));

  const bad = rows.filter((r) => {
    const t = (r.metadata as Record<string, unknown> | null)?.templateId;
    return t != null && !isRegisteredTemplateId(t);
  });

  console.log(`近 90 天 article ${rows.length} 篇 ｜ 已注册模板: ${listTemplates().map((t) => t.id).join(" / ")}`);
  console.log(`\n🔴 templateId 非法: ${bad.length} 条`);
  const by = new Map<string, number>();
  for (const r of bad) {
    const t = String((r.metadata as Record<string, unknown>).templateId);
    by.set(t, (by.get(t) ?? 0) + 1);
  }
  for (const [t, n] of [...by].sort((a, b) => b[1] - a[1])) {
    const why = FAKE_FROM_LETTER[t] ? `虚构模板名(源自人设字母 ${FAKE_FROM_LETTER[t]}，无实现)` : PERSONA_LETTERS.has(t) ? "人设字母漏进模板字段" : "未知";
    console.log(`   ${t.padEnd(20)} ${String(n).padStart(3)} 条  ← ${why}`);
  }

  if (!APPLY) {
    console.log("\n（只读。收口完成后本脚本应报 0 条；加 --apply 修正存量）");
    process.exit(bad.length === 0 ? 0 : 1);
  }

  let n = 0;
  for (const r of bad) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const orig = String(m.templateId);
    const letter = FAKE_FROM_LETTER[orig] ?? (PERSONA_LETTERS.has(orig) ? orig : null);
    await db
      .update(contents)
      .set({
        metadata: {
          ...m,
          // 实际渲染用的就是默认模板（getTemplate 返 null → fallback），见 article-skill 的 fallback 日志
          templateId: DEFAULT_TEMPLATE_ID,
          ...(letter ? { personaLetter: letter } : {}),
          originalTemplateId: orig,
          templateIdFixedBy: "audit-template-ids 8-13",
        },
        updatedAt: new Date(),
      })
      .where(eq(contents.id, r.id));
    n++;
  }
  console.log(`\n已修正 ${n} 条 → templateId=${DEFAULT_TEMPLATE_ID}，原值存 originalTemplateId，人设字母存 personaLetter`);
  process.exit(0);
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
