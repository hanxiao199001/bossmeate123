/**
 * 台账接线（8-14 Phase 1）—— **只在真正的生产链路上打开**。
 *
 * ## 为什么要显式接线，而不是让检查器自己记账
 *
 * `checkOutputHealth` 是纯函数（无 LLM/网络/DB，毫秒级），这是它能被到处调用的前提；
 * 它同时被单测、审计脚本、样例脚本调用。若在函数内部直接写库：
 *   ① 毁掉纯函数契约
 *   ② **台账里混进测试数据** —— 第一条记录就不可信，而这套台账的全部价值就是可信
 *
 * 所以记账做成显式接线：服务启动时调用一次 `wireCheckerLedger()`，
 * 脚本与单测不调 = 不记账。
 */
import { setHealthLedgerHook, type OutputHealthCode } from "../publisher/output-health.js";
import { recordCheckerRun } from "./checker-ledger.js";
import { listCheckers } from "./checker-registry.js";
import { logger } from "../../config/logger.js";

/** 出稿健康闸的 code → checker_id（注册处用带前缀的名字，避免与别的闸重名） */
const HEALTH_CHECKER_ID = (code: string) => `output_health.${code}`;

/** 已注册的出稿健康闸 code 集合 —— 只给注册过的记账，防止拼错名字凭空造出一个 checker */
let knownHealthCodes: Set<string> | null = null;

export function wireCheckerLedger(): void {
  knownHealthCodes = new Set(
    listCheckers()
      .map((c) => c.id)
      .filter((id) => id.startsWith("output_health."))
      .map((id) => id.slice("output_health.".length)),
  );

  setHealthLedgerHook((codes: OutputHealthCode[]) => {
    const hit = new Set<string>(codes);
    /**
     * 🔴 evaluated 与 hits 的口径：
     *   每次 `checkOutputHealth` 调用 = 每个 code **各评估一次**（它们都跑了）；
     *   命中的那几个额外 +1 hit。
     * 这样命中率 = hits/evaluated 才是「这道判据在多少输入上报警」，
     * 而不是「报警的占报警的多少」（后者恒为 1，毫无信息）。
     */
    for (const code of knownHealthCodes ?? []) {
      void recordCheckerRun(HEALTH_CHECKER_ID(code), 1, hit.has(code) ? 1 : 0);
    }
  });

  logger.info({ codes: [...(knownHealthCodes ?? [])].length }, "checker_ledger.wired");
}
