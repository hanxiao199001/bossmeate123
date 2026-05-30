/**
 * 中文核心去重：把仅标点不同的同名重复刊合并（北大核心用括号、CSSCI 用点号，
 * 如「北京大学学报(哲学社会科学版)」vs「北京大学学报.哲学社会科学版」）。
 *
 * 策略（安全）：同 normName 的多行选一个"主刊"（有 ISSN > confidence 高 > 非 catalog 源 > 标签多），
 *   把所有 catalogs/pkuCoreLevel/cscdLevel/issn 合并到主刊；其余副本设 status='disabled'（不删除，可逆，不破坏引用）。
 *
 * 红线 DB 护栏：默认 dry-run 只报计划，加 --apply 才写库。
 * 用法: node dist/scripts/dedup-domestic-journals.js [--apply]
 */
import { eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { logger } from "../config/logger.js";

export function normNameStrict(name: string): string {
  if (!name) return "";
  let s = name;
  s = s.replace(/[（(]\s*改名为[：:][^)）]*[)）]/g, "").replace(/\[\s*改名为[^\]]*\]/g, "");
  s = s.replace(/（/g, "(").replace(/）/g, ")").replace(/，/g, ",").replace(/•/g, "·");
  s = s.replace(/\s+/g, "").replace(/^[《\s]+|[》\s]+$/g, "");
  // 统一 ".XX版" → "(XX版)" — 标点重复的根因
  s = s.replace(/\.([一-龥A-Za-z0-9]+版)\)?$/, "($1)");
  return s;
}

type J = {
  id: string; name: string | null; issn: string | null;
  catalogs: unknown; confidence: number | null; source: string | null;
  pkuCoreLevel: string | null; cscdLevel: string | null; status: string;
};

function score(j: J): number {
  // 越大越优先当主刊
  let s = 0;
  if (j.issn) s += 1000;
  s += (j.confidence ?? 0);
  if (j.source && j.source !== "domestic-catalog") s += 500; // 真实/已富化优先
  if (Array.isArray(j.catalogs)) s += (j.catalogs as string[]).length;
  return s;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const all = (await db.select({
    id: journals.id, name: journals.name, issn: journals.issn, catalogs: journals.catalogs,
    confidence: journals.confidence, source: journals.source,
    pkuCoreLevel: journals.pkuCoreLevel, cscdLevel: journals.cscdLevel, status: journals.status,
  }).from(journals)) as J[];

  const groups = new Map<string, J[]>();
  for (const j of all) {
    if (j.status === "disabled") continue;
    const k = normNameStrict(j.name ?? "");
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  const affected = dupGroups.reduce((s, g) => s + g.length, 0);
  console.log(`[dedup] 重复组: ${dupGroups.length} | 涉及行: ${affected} | 将禁用副本: ${affected - dupGroups.length}`);

  const plan = dupGroups.map((g) => {
    const sorted = [...g].sort((a, b) => score(b) - score(a));
    const primary = sorted[0];
    const losers = sorted.slice(1);
    const cats = Array.from(new Set(g.flatMap((x) => (Array.isArray(x.catalogs) ? (x.catalogs as string[]) : []))));
    const issn = primary.issn || losers.find((l) => l.issn)?.issn || null;
    const pku = primary.pkuCoreLevel || losers.find((l) => l.pkuCoreLevel)?.pkuCoreLevel || null;
    const cscd = primary.cscdLevel || losers.find((l) => l.cscdLevel)?.cscdLevel || null;
    return { primary, losers, cats, issn, pku, cscd };
  });

  if (!apply) {
    console.log("[dedup] DRY-RUN（未写库）。样例（主刊 ⇐ 禁用副本）:");
    for (const p of plan.slice(0, 10)) {
      console.log(`  «${p.primary.name}» ⇐ ${p.losers.map((l) => `«${l.name}»`).join(", ")}`);
    }
    console.log("确认无误后加 --apply 执行。");
    process.exit(0);
  }

  let merged = 0, disabled = 0;
  for (const p of plan) {
    await db.update(journals).set({
      catalogs: p.cats,
      ...(p.issn && !p.primary.issn ? { issn: p.issn } : {}),
      ...(p.pku && !p.primary.pkuCoreLevel ? { pkuCoreLevel: p.pku } : {}),
      ...(p.cscd && !p.primary.cscdLevel ? { cscdLevel: p.cscd } : {}),
    }).where(eq(journals.id, p.primary.id));
    merged++;
    for (const l of p.losers) {
      await db.update(journals).set({ status: "disabled" }).where(eq(journals.id, l.id));
      disabled++;
    }
  }
  logger.info({ merged, disabled }, "[dedup] 完成");
  console.log(`[dedup] 完成: 合并主刊 ${merged} | 禁用副本 ${disabled}`);
  process.exit(0);
}

main().catch((err) => { logger.error({ err }, "[dedup] 失败"); process.exit(1); });
