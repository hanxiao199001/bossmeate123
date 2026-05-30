/**
 * 中文核心目录 upsert ingest（北大核心 / CSSCI / CSSCI扩展 / CSCD → journals 池）。
 *
 * 数据源: src/data/{pku-core,cssci,cssci-ext,cscd}-2023.json（parse-domestic-core.py 产出）。
 * 匹配: 有 ISSN(CSCD) 先按 ISSN 精确匹配, 否则按刊名归一化匹配池中 journals。
 *   命中 → 追加 catalogs[] + 设 pkuCoreLevel/cscdLevel/catalogYear（COALESCE 不覆盖已有 issn/discipline）。
 *   未命中 → 新建 journal 行（tenantId=null 全局共享, source='domestic-catalog', confidence=55）。
 *
 * 红线 DB 护栏: 默认 dry-run 只报计划, 加 --apply 才写库。
 * 用法: node dist/scripts/ingest-domestic-core.js [--apply]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { logger } from "../config/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "../data");

export function normName(name: string): string {
  if (!name) return "";
  let s = name;
  s = s.replace(/[（(]\s*改名为[：:][^)）]*[)）]/g, "");
  s = s.replace(/\[\s*改名为[^\]]*\]/g, "");
  s = s.replace(/（/g, "(").replace(/）/g, ")").replace(/，/g, ",").replace(/•/g, "·");
  s = s.replace(/\s+/g, "");
  s = s.replace(/^[《\s]+|[》\s]+$/g, "");
  return s;
}

interface CatRow { name: string; issn?: string | null; cscdLevel?: string | null; discipline?: string | null; }
interface Unified {
  name: string; normName: string; issn: string | null;
  catalogs: Set<string>; cscdLevel: string | null; discipline: string | null;
}

export function mergeCatalogs(files: Record<string, CatRow[]>): Map<string, Unified> {
  const merged = new Map<string, Unified>();
  for (const [cat, rows] of Object.entries(files)) {
    for (const r of rows) {
      const k = normName(r.name);
      if (!k) continue;
      let m = merged.get(k);
      if (!m) {
        m = { name: r.name, normName: k, issn: null, catalogs: new Set(), cscdLevel: null, discipline: null };
        merged.set(k, m);
      }
      m.catalogs.add(cat);
      if (r.issn && !m.issn) m.issn = r.issn;
      if (r.cscdLevel) m.cscdLevel = r.cscdLevel;
      if (r.discipline && !m.discipline) m.discipline = r.discipline;
    }
  }
  return merged;
}

function load(name: string): CatRow[] {
  return JSON.parse(readFileSync(resolve(DATA, name), "utf8"));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const files: Record<string, CatRow[]> = {
    "pku-core": load("pku-core-2023.json"),
    "cssci": load("cssci-2023.json"),
    "cssci-ext": load("cssci-ext-2023.json"),
    "cscd": load("cscd-2023.json"),
  };
  const merged = mergeCatalogs(files);
  console.log(`[domestic-core] 合并后唯一中文核心刊: ${merged.size}`);

  // 载入池子(全局 + 各租户 reference 行), 建 ISSN / 归一刊名 索引
  const pool = await db.select({ id: journals.id, name: journals.name, issn: journals.issn, catalogs: journals.catalogs }).from(journals);
  const byIssn = new Map<string, typeof pool[number]>();
  const byNorm = new Map<string, typeof pool[number]>();
  for (const p of pool) {
    if (p.issn) byIssn.set(p.issn.toUpperCase(), p);
    if (p.name) byNorm.set(normName(p.name), p);
  }

  let matched = 0, toInsert = 0;
  const updates: { id: string; catalogs: string[]; pku: string | null; cscd: string | null }[] = [];
  const inserts: Unified[] = [];

  for (const u of merged.values()) {
    const hit = (u.issn && byIssn.get(u.issn.toUpperCase())) || byNorm.get(u.normName);
    const newCats = [...u.catalogs];
    const pku = u.catalogs.has("pku-core") ? "北大核心" : null;
    if (hit) {
      matched++;
      const existing = Array.isArray(hit.catalogs) ? (hit.catalogs as string[]) : [];
      const cats = Array.from(new Set([...existing, ...newCats]));
      updates.push({ id: hit.id, catalogs: cats, pku, cscd: u.cscdLevel });
    } else {
      toInsert++;
      inserts.push(u);
    }
  }

  console.log(`[domestic-core] 命中池中(打标): ${matched} | 池中无(新建): ${toInsert}`);
  if (!apply) {
    console.log("[domestic-core] DRY-RUN（未写库）。确认无误后加 --apply 执行。");
    console.log("  新建样例:", inserts.slice(0, 5).map((x) => x.name));
    process.exit(0);
  }

  // 写库
  let upd = 0, ins = 0;
  for (const u of updates) {
    await db.update(journals).set({
      catalogs: u.catalogs,
      ...(u.pku ? { pkuCoreLevel: u.pku } : {}),
      ...(u.cscd ? { cscdLevel: u.cscd } : {}),
      catalogYear: "2023",
    }).where(eq(journals.id, u.id));
    upd++;
    if (upd % 200 === 0) console.log(`  打标进度 ${upd}/${updates.length}`);
  }
  for (const u of inserts) {
    await db.insert(journals).values({
      tenantId: null,
      name: u.name,
      nameEn: u.name,
      issn: u.issn,
      discipline: u.discipline,
      catalogs: [...u.catalogs],
      ...(u.catalogs.has("pku-core") ? { pkuCoreLevel: "北大核心" } : {}),
      ...(u.cscdLevel ? { cscdLevel: u.cscdLevel } : {}),
      catalogYear: "2023",
      source: "domestic-catalog",
      confidence: 55,
    });
    ins++;
    if (ins % 200 === 0) console.log(`  新建进度 ${ins}/${inserts.length}`);
  }
  logger.info({ matched: upd, inserted: ins }, "[domestic-core] ingest 完成");
  console.log(`[domestic-core] 完成: 打标 ${upd} + 新建 ${ins}`);
  process.exit(0);
}

main().catch((err) => { logger.error({ err }, "[domestic-core] 失败"); process.exit(1); });
