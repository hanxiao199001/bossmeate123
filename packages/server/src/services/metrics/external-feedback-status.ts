/**
 * 外部效果数据（公众号阅读回流）的**可用性**声明 —— 唯一真相源。8-20 建。
 *
 * ═══ 这个文件为什么存在 ═══
 *
 * 8-20 查明：`wechat-stats-collector` 从 7-06 起每天 09:10 准时跑，
 * 7 个公众号 **7/7 返回 `errcode=48001`「该号无数据分析权限」** ——
 * 微信 datacube 接口要求**已认证**公众号，我们的号都是未认证订阅号。
 *
 * 后果是 `content_metrics` **一行都没有**（空表）。
 *
 * 而这件事一个多月没人知道，因为那行日志是 `level:30` info，
 * 代码注释写着「优雅跳过记日志」—— **优雅得没人看见**。
 *
 * ▎ 老韩 8-20 的处置原则：**留着一个每天跑、每天失败的任务，就是在制造下一个盲区。**
 *   关这条线可以，但要关干净：停 cron + 所有依赖它的功能显式标记不可用。
 *
 * ═══ 为什么"接了线但收不到数据"比"没接线"更糟 ═══
 *
 * 效果回流 / 选题反馈 / 标题学习三个功能在界面上都**存在**、都不报错、都返回空结果。
 * 空结果长得像"目前还没有反馈"，而实际是"这条管道永远不会有数据"。
 * **它会让人以为系统在学习。** 红线 #14 在功能层的形态：
 * 降级产物（空数组）与真产物（还没攒够数据的空数组）不可区分。
 *
 * ═══ 改这个文件的条件 ═══
 *
 * 只有一个：**公众号完成微信认证**。那是行政动作，不是工程动作 ——
 * 代码、cron、标题匹配、幂等写入、`published_by_operator` 升级全部就绪且验证过。
 * 认证一通，把 `available` 改回 true、重新注册 cron 即可，无需改任何业务代码。
 */

/** 外部效果数据当前是否可用。false = 依赖它的一切功能都收不到数据。 */
export const EXTERNAL_FEEDBACK_AVAILABLE = false as boolean;

/** 停用起始日（本条声明生效日） */
export const EXTERNAL_FEEDBACK_DISABLED_SINCE = "2026-08-20";

/** 给运营看的一句话。**只陈述事实与解锁条件，不写归因**（红线 #13）。 */
export const EXTERNAL_FEEDBACK_NOTICE =
  "公众号阅读数据未接入：微信数据分析接口要求已认证公众号，当前 7 个号均为未认证订阅号（接口返回 48001）。" +
  "依赖阅读数据的功能（效果回流 / 选题反馈 / 标题学习）不会有数据，显示为空**不代表**还在积累。" +
  "解锁条件：完成微信认证，无需改动代码。";

/** 受影响的功能清单 —— 界面上要显式标注这几处，别让空结果冒充"还没攒够"。 */
export const EXTERNAL_FEEDBACK_DEPENDENTS = [
  { key: "effect_dashboard", label: "效果看板（阅读/分享/收藏）", note: "只剩运营手填的部分" },
  { key: "topic_feedback", label: "选题反馈（哪类选题读者买账）", note: "无数据" },
  { key: "title_learning", label: "标题学习（运营改过的标题当范例）", note: "无数据，titleFeedback 恒为空" },
  { key: "publish_confirm", label: "推的草稿是否被真发布", note: "无法判定，见 publish_state_unknown" },
] as const;

export interface ExternalFeedbackStatus {
  available: boolean;
  disabledSince: string | null;
  notice: string | null;
  dependents: Array<{ key: string; label: string; note: string }>;
}

/**
 * 给 API 返回用。**不可用时必须带上 notice** —— 前端据此显示横幅。
 *
 * 🔴 不要在调用方另写一份判断（`if (metrics.length === 0) 显示"暂无数据"`）：
 * 那正是本文件要消灭的东西 —— "暂无"和"永远不会有"必须在界面上区分开。
 */
export function getExternalFeedbackStatus(): ExternalFeedbackStatus {
  return {
    available: EXTERNAL_FEEDBACK_AVAILABLE,
    disabledSince: EXTERNAL_FEEDBACK_AVAILABLE ? null : EXTERNAL_FEEDBACK_DISABLED_SINCE,
    notice: EXTERNAL_FEEDBACK_AVAILABLE ? null : EXTERNAL_FEEDBACK_NOTICE,
    dependents: EXTERNAL_FEEDBACK_DEPENDENTS.map((d) => ({ ...d })),
  };
}
