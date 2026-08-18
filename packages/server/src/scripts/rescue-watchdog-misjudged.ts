/**
 * 救回被 watchdog 误判的已完成内容（8-18）。**默认只读，加 --apply 才写。**
 *
 * ## 案情
 *
 * watchdog 的判死线是 10 分钟，而 8-17 那晚成功组耗时 **max 9.7 分钟** —— 余量 3%。
 * 3 篇越线被判 failed，但**生成并没有停**：继续跑到 34-41 分钟才完成，
 * LLM 的钱全花了、内容也算出来了（11027 / 11420 / 6736 字，结尾页脚完整、口播稿齐全），
 * 只是最后那步 `generating → generated` 撞上已被改掉的状态，产出作废。
 *
 * **那些字是花了钱的**，不该当普通失败埋掉。
 *
 * ## 救法：走合法路径，不放宽状态机
 *
 * `failed → needs_review` 不在允许表里（failed 只能去 generating / archived）。
 * 所以走 `failed → generating → needs_review` 两步 —— 本来就合法，语义也诚实。
 * **不为了救 3 条内容去改状态机的允许表**：那张表是全链路的约束，
 * 为一次性处置放宽它，代价会在别处出现。
 *
 * 归宿是 `needs_review` 而不是 `generated`：三条的六维分是 63 / 59 / 47，
 * 都低于质量线 70 —— 它们本来就该进人工复核，救回来不等于放行。
 *
 * metadata 留痕 `rescuedFrom` —— 救回来的和正常产出必须可区分（红线 #14）。
 *
 * ```bash
 * npx tsx src/scripts/rescue-watchdog-misjudged.ts          # 只看
 * npx tsx src/scripts/rescue-watchdog-misjudged.ts --apply  # 真改
 * ```
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { transitionToStatus } from "../services/articles/state-machine.js";

const APPLY = process.argv.includes("--apply");
/** 完整成品的下限：低于这个字数说明生成真的没跑完，不该救 */
const MIN_BODY_CHARS = 3000;

async function main() {
  const rows = await db
    .select({ id: contents.id, title: contents.title, body: contents.body, meta: contents.metadata })
    .from(contents)
    .where(and(eq(contents.status, "failed"), eq(contents.type, "article")));

  const plain = (b: string | null) => String(b ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
  const candidates = rows.filter((r) => plain(r.body) >= MIN_BODY_CHARS);

  console.log(`failed 的文章 ${rows.length} 条 ｜ 正文 ≥ ${MIN_BODY_CHARS} 字（= 内容其实跑完了）${candidates.length} 条\n`);
  for (const r of candidates) {
    const m = (r.meta ?? {}) as Record<string, unknown>;
    console.log(`   ${r.id.slice(0, 8)}  ${plain(r.body)} 字  六维=${m.sixDimTotal ?? "-"}  ${String(r.title).slice(0, 30)}`);
  }

  if (!APPLY) {
    console.log("\n（只读模式。确认后加 --apply）");
    process.exit(0);
  }

  let ok = 0;
  for (const r of candidates) {
    try {
      // 两步合法路径：failed → generating → needs_review
      await transitionToStatus(r.id, "generating");
      await transitionToStatus(r.id, "needs_review");
      await db
        .update(contents)
        .set({
          metadata: sql`coalesce(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify({
            rescuedFrom: "watchdog_false_kill",
            rescuedAt: new Date().toISOString(),
            rescueNote: "内容已生成完整但被 10 分钟判死线误判为失败；救回后按质检结果落 needs_review",
          })}::jsonb`,
        })
        .where(eq(contents.id, r.id));
      ok++;
      console.log(`   ✔ ${r.id.slice(0, 8)} → needs_review`);
    } catch (err) {
      console.log(`   ⚠️ ${r.id.slice(0, 8)} 救援失败：${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n完成 ${ok}/${candidates.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
