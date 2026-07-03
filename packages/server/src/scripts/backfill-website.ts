/**
 * PR #181 — backfill journals.website (用 Crossref API, 免费无限额).
 *
 * 用法:
 *   ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/backfill-website.js'
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { eq, or, isNull, sql } from "drizzle-orm";

const THROTTLE_MS = 500;

// Crossref /journals/{issn} 返 publisher URL
async function lookupWebsite(issn: string, name: string): Promise<string | null> {
  // Try Crossref
  try {
    const resp = await fetch(`https://api.crossref.org/journals/${issn}`, {
      headers: { "User-Agent": "BossMate/1.0 (mailto:bossmate@example.com)" },
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      const url = data?.message?.["publisher-url"] || data?.message?.URL;
      if (url && /^https?:\/\//i.test(url)) return url;
    }
  } catch { /* ignore */ }

  // Fallback: well-known journal mapping
  const knownMap: Record<string, string> = {
    "0001-8392": "https://journals.sagepub.com/home/asq",
    "0003-990X": "https://jamanetwork.com/journals/jamapsychiatry",
    "0003-9926": "https://jamanetwork.com/journals/jamainternalmedicine",
    "0003-9950": "https://jamanetwork.com/journals/jamaophthalmology",
    "1756-1833": "https://www.bmj.com",
    "0903-1936": "https://erj.ersjournals.com",
    "0301-620X": "https://boneandjoint.org.uk/journal/BJJ",
    "0149-2063": "https://journals.sagepub.com/home/jom",
    "0162-1459": "https://www.tandfonline.com/journals/uasa20",
    "0034-6543": "https://journals.sagepub.com/home/rer",
    "0363-6135": "https://journals.physiology.org/journal/ajpheart",
    "1539-4522": "https://opg.optica.org/ao/home.cfm",
    "0014-2956": "https://febs.onlinelibrary.wiley.com/journal/14321033",
  };
  if (knownMap[issn]) return knownMap[issn];

  return null;
}

async function main() {
  const candidates = await db
    .select({ id: journals.id, nameEn: journals.nameEn, name: journals.name, issn: journals.issn, website: journals.website })
    .from(journals)
    .where(or(
      isNull(journals.website),
      sql`website LIKE '%idp.springer%'`,
    ));

  console.log(`[backfill-website] 找到 ${candidates.length} 本需修复`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const j = candidates[i];
    if (!j.issn) { failed++; continue; }

    const website = await lookupWebsite(j.issn, j.nameEn || j.name);
    if (website) {
      await db.update(journals).set({ website }).where(eq(journals.id, j.id));
      updated++;
      console.log(`  ✅ ${j.nameEn || j.name}: ${website}`);
    } else {
      failed++;
      console.log(`  ❌ ${j.nameEn || j.name}: not found`);
    }

    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }

  // 最终统计
  const stats = await db.execute(sql`
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE website IS NULL) AS null_count,
      COUNT(*) FILTER (WHERE website IS NOT NULL) AS has_url
    FROM journals WHERE confidence >= 60
  `);

  console.log(`\n[backfill-website] 完成: updated=${updated}, failed=${failed}`);
  console.log("统计:", (stats as any).rows[0]);
}

main().catch(err => { console.error(err); process.exit(1); });
