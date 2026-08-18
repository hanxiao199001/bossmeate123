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
import { WATCHDOG_ERROR_MESSAGE } from "../services/articles/watchdog.js";

const APPLY = process.argv.includes("--apply");
/**
 * 完整成品的下限（**净正文**，剥 HTML 与空白之后）。
 *
 * 🔴 8-18 我第一次把这个数定成 3000，结果 0 条候选 —— **因为定错了单位**：
 * 那 3 条的 raw body 是 11027/11420/6736 字，但那里面绝大部分是 HTML 标签与样式，
 * 净正文只有 869 / 972 / 1277 字。我拿 raw 长度去卡净长度的门槛。
 *
 * 用同晚的真实分布校准：
 * ```
 * needs_review(正常成品) n=20  净长度 min 401 / 均 1312 / max 2051
 * 被误杀的 3 条                869 / 972 / 1277   ← 同一量级
 * ```
 * 400 = 正常成品的实测下限。低于它才谈得上"生成真没跑完"。
 */
const MIN_BODY_CHARS = 400;

async function main() {
  const rows = await db
    .select({
      id: contents.id,
      title: contents.title,
      body: contents.body,
      meta: contents.metadata,
      err: contents.errorMessage,
      createdAt: contents.createdAt,
      failedAt: contents.updatedAt,
    })
    .from(contents)
    .where(and(eq(contents.status, "failed"), eq(contents.type, "article")));

  const plain = (b: string | null) => String(b ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
  /**
   * 🔴 两个条件**都要**满足，缺一不可：
   *   ① 净正文 ≥ 下限 —— 内容确实写出来了
   *   ② error_message 是 watchdog 的超时文案 —— 它确实是被**误杀**的
   *
   * 只用 ① 是不够的：那只证明"内容写出来了"，不证明"它该被救"。
   * 被编造闸/合规闸正当拦下的内容同样有完整正文，救回去就是把该拦的放进待审。
   * （实测这批恰好 35/35 都是 timeout，但判据不能建立在"恰好"上 —— 红线 #16。）
   */
  const isWatchdogKill = (r: { err: string | null; meta: unknown }) => {
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const text = `${r.err ?? ""} ${String(m.errorMessage ?? "")}`;
    return text.includes(WATCHDOG_ERROR_MESSAGE) || /Generation timeout/i.test(text);
  };
  const candidates = rows.filter(
    (r) => plain(r.body) >= MIN_BODY_CHARS && isWatchdogKill({ err: r.err, meta: r.meta }),
  );

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
            /**
             * 🔴 原始生成时间必须留 —— 审的人要一眼看到「这是 7-28 生成的」，
             * 自己决定数据过没过期。**让人能区分，而不是替人决定**：
             * 脚本不该按日期替审稿人筛掉三周前的内容，那是他的判断不是我的。
             */
            originalCreatedAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
            originalFailedAt: r.failedAt instanceof Date ? r.failedAt.toISOString() : String(r.failedAt),
            rescueNote: "内容已生成完整但被 10 分钟判死线误判为失败；救回后按质检结果落 needs_review。数据为原始生成时的快照。",
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
