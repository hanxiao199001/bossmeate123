/**
 * 6-16: 抖音/视频号「派单给本地 Agent」的唯一实现。
 *
 * 背景: 这套拆分逻辑之前散在三处且不一致 —
 *   - /agent-admin/dispatch 路由自己建任务
 *   - TodayPage 前端按平台拆 agentIds/serverIds
 *   - 内容工坊直发完全没拆 → 选视频号账号发视频会静默打到没凭证的 /publish 失败
 * 现在统一: publishToAccounts(/publish) 与 /agent-admin/dispatch 都调这里,
 * 「视频→Agent / 文章→服务器」的判定只此一处 (AGENT_PLATFORMS)。
 */
import { db } from "../../models/db.js";
import { agentPublishTasks } from "../../models/schema.js";
import { buildPushCaptions } from "./draft-push.js";

/** 登录态在客户本机、服务器无凭证的平台 → 走本地 Agent 推草稿, 不走服务器凭证发布 */
export const AGENT_PLATFORMS = new Set(["douyin", "wechat_video"]);

export type DispatchAccount = { id: string; accountName: string; platform: string };
export type AgentTaskRow = typeof agentPublishTasks.$inferSelect;

/**
 * 给每个账号建一条 Agent 发布任务(视频)。要求 content 为视频且 body 是视频地址。
 * 文案/标题复用 buildPushCaptions(与 draft-push 同源, 按账号序号对应差异化 variants)。
 * accounts 为空直接返回 []; 非视频则抛错(调用方决定如何呈现)。
 */
export async function dispatchVideoToAgent(params: {
  content: { id: string; type: string; title: string | null; body: string | null };
  tenantId: string;
  accounts: DispatchAccount[];
}): Promise<AgentTaskRow[]> {
  const { content, tenantId, accounts } = params;
  if (accounts.length === 0) return [];
  const videoSource = content.type === "video" ? content.body : null;
  if (!videoSource) throw new Error("内容不是视频或缺少视频地址，无法派单给本地 Agent");
  const { captions, titles } = await buildPushCaptions(content.id, tenantId, accounts);
  return db
    .insert(agentPublishTasks)
    .values(
      accounts.map((a, i) => ({
        tenantId,
        contentId: content.id,
        accountId: a.id,
        platform: a.platform,
        accountName: a.accountName,
        videoSource,
        caption: captions[i] ?? captions[0] ?? content.title ?? "",
        title: (titles[i] ?? titles[0] ?? content.title ?? "").slice(0, 200),
      })),
    )
    .returning();
}
