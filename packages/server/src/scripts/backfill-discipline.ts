/**
 * PR #180 — 回填 journals.discipline (从 DB jcr_full + journal name 推断, 0 API 调用).
 *
 * 用法:
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/backfill-discipline.js'
 *
 * 行为:
 *   1. SELECT journals WHERE discipline IS NULL
 *   2. 优先从 jcr_full.jifSubjects[].subject 推断
 *   3. fallback: 从 journal name_en 关键词推断
 *   4. UPDATE discipline
 *   5. 输出分布报告
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, eq, or, isNull } from "drizzle-orm";

/**
 * 从 JCR subject 字符串推断学科.
 * jifSubjects[].subject 格式: "MEDICINE, GENERAL & INTERNAL" / "PSYCHOLOGY, CLINICAL" 等
 */
export function inferDisciplineFromJCR(jcrFull: any): string | null {
  const subjects: string[] = [];
  if (jcrFull?.jifSubjects) {
    for (const s of jcrFull.jifSubjects) {
      if (s.subject) subjects.push(s.subject.toLowerCase());
    }
  }
  if (jcrFull?.jciSubjects) {
    for (const s of jcrFull.jciSubjects) {
      if (s.subject) subjects.push(s.subject.toLowerCase());
    }
  }
  const all = subjects.join(" ");
  if (!all) return null;

  return mapSubjectToDiscipline(all);
}

/**
 * 从 journal name 推断学科 (fallback).
 */
export function inferDisciplineFromName(name: string): string {
  const lower = (name || "").toLowerCase();
  if (/\b(lancet|jama|bmj|nejm|medicine|clinical|cancer|cardio|surg|nurs|pharm|immun|infect|epidem|oncol|pathol|radiol|anesthes|dermat|gastro|hepat|nephro|neurol|ophthal|otolar|pediatr|psychiat|urol)\b/.test(lower)) return "medicine";
  if (/\b(psychol|cognit|behav|mental)\b/.test(lower)) return "psychology";
  if (/\b(educ|teach|learn|pedagog|curricul)\b/.test(lower)) return "education";
  if (/\b(econom|financ|business|manag|account|market)\b/.test(lower)) return "economics";
  if (/\b(engineer|material|energy|electr|mechan|autom)\b/.test(lower)) return "engineering";
  if (/\b(comput|inform|software|artificial|intellig|data sci|cyber|robot)\b/.test(lower)) return "computer";
  if (/\b(biolog|biochem|genetic|molecul|cell|microb|ecolog|zoolog|botan)\b/.test(lower)) return "biology";
  if (/\b(chem|catalys|polym)\b/.test(lower)) return "chemistry";
  if (/\b(physic|astron|quantum|optic)\b/.test(lower)) return "physics";
  if (/\b(agric|plant|crop|soil|food|horti|veterina|animal|aqua|forest)\b/.test(lower)) return "agriculture";
  if (/\b(environ|earth|climat|geolog|ocean|atmosph|sustain)\b/.test(lower)) return "environment";
  if (/\b(law|legal|juris|crimin)\b/.test(lower)) return "law";
  if (/\b(social|sociol|polit|commun|anthropo|geograph)\b/.test(lower)) return "economics";
  if (/\b(nature|science|pnas|plos|frontier|springer|wiley)\b/.test(lower)) return "multidisciplinary";
  return "multidisciplinary";
}

function mapSubjectToDiscipline(subjectText: string): string | null {
  if (/medicine|surgery|clinical|oncology|cancer|cardio|gastro|hepat|nephro|neurology|dermat|pathol|radiol|anesthes|nursing|pharmac|immunol|infectious|epidem|pediatr|obstet|ophthal|otolar|urol|transplant|critical care|emergency|geriatr|rehabilit|tropical|public health/.test(subjectText)) return "medicine";
  if (/psychology|psychiatr|behavioral|cognitive/.test(subjectText)) return "psychology";
  if (/education|pedagog/.test(subjectText)) return "education";
  if (/economics|finance|business|management|accounting|operations research/.test(subjectText)) return "economics";
  if (/engineering|material|energy|electric|mechanical|civil|aerospace|autom|manufactur|industrial|nuclear|transportation/.test(subjectText)) return "engineering";
  if (/computer|information|software|artificial|robotics|cybernetic/.test(subjectText)) return "computer";
  if (/biology|biochem|genetic|molecular|cell|microbio|ecology|zoology|botany|marine|entomol|ornithol|evolutionary|developmental|anatomy|physiology/.test(subjectText)) return "biology";
  if (/chemistry|chemical|polymer|catalys|electroch|analytical|organic|inorganic/.test(subjectText)) return "chemistry";
  if (/physics|astronomy|quantum|optical|acoust|nuclear|mathematical phys|thermodynamic/.test(subjectText)) return "physics";
  if (/agricultur|plant|crop|soil|food|horti|veterinar|animal|aquacultur|forestry|agronomy/.test(subjectText)) return "agriculture";
  if (/environmental|earth|climate|geolog|ocean|atmosph|water|ecology|geoscien|meteorol/.test(subjectText)) return "environment";
  if (/law|legal|criminol/.test(subjectText)) return "law";
  if (/social|sociolog|political|communication|anthropol|geography|demograph|urban|ethnic/.test(subjectText)) return "economics";
  if (/multidisciplinary|general|interdisciplinary/.test(subjectText)) return "multidisciplinary";
  return null;
}

async function main() {
  const candidates = await db
    .select({
      id: journals.id,
      name: journals.name,
      nameEn: journals.nameEn,
      jcrFull: journals.jcrFull,
    })
    .from(journals)
    // PR #193 (5-20): 候选除 NULL/空, 加 'multidisciplinary' 重推错标 (enrich 补 jcr_full 后修正, 真综合刊重判回保持)
    .where(or(isNull(journals.discipline), eq(journals.discipline, ""), eq(journals.discipline, "multidisciplinary")));

  console.log(`[backfill-discipline] 找到 ${candidates.length} 个 discipline=NULL 的期刊`);

  let updated = 0;
  let fromJcr = 0;
  let fromName = 0;
  let fallback = 0;

  for (let i = 0; i < candidates.length; i++) {
    const j = candidates[i];

    // 优先 jcr_full
    let discipline = inferDisciplineFromJCR(j.jcrFull);
    if (discipline) {
      fromJcr++;
    } else {
      // fallback: journal name
      discipline = inferDisciplineFromName(j.nameEn || j.name);
      if (discipline === "multidisciplinary") {
        fallback++;
      } else {
        fromName++;
      }
    }

    try {
      await db.update(journals).set({ discipline }).where(eq(journals.id, j.id));
      updated++;
    } catch {
      console.error(`[backfill] UPDATE 失败: ${j.nameEn}`);
    }

    if ((i + 1) % 100 === 0) {
      console.log(`[backfill] progress: ${i + 1}/${candidates.length} (jcr=${fromJcr}, name=${fromName}, fallback=${fallback})`);
    }
  }

  // 报告
  const report = await db.execute(sql`
    SELECT discipline, COUNT(*) AS cnt FROM journals
    WHERE confidence >= 60
    GROUP BY discipline ORDER BY cnt DESC
  `);

  console.log("\n=== 回填后学科分布 (confidence>=60) ===");
  for (const r of (report as any).rows) {
    console.log(`  ${(r.discipline || "(null)").padEnd(20)} ${r.cnt}`);
  }

  console.log(`\n[backfill-discipline] 完成: updated=${updated} (jcr=${fromJcr}, name=${fromName}, fallback=${fallback})`);
}

main().catch(err => {
  console.error("[backfill-discipline] fatal:", err);
  process.exit(1);
});
