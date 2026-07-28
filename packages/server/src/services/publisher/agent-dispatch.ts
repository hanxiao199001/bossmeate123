/**
 * 6-16: 抖音/视频号「派单给本地 Agent」的唯一实现。
 *
 * 背景: 这套拆分逻辑之前散在三处且不一致 —
 *   - /agent-admin/dispatch 路由自己建任务
 *   - TodayPage 前端按平台拆 agentIds/serverIds
 *   - 内容工坊直发完全没拆 → 选视频号账号发视频会静默打到没凭证的 /publish 失败
 * 现在统一: publishToAccounts(/publish) 与 /agent-admin/dispatch 都调这里。
 *
 * 7-28 阶段1-B: 「视频→Agent / 文章→服务器」的判定原本在这里定义 (AGENT_PLATFORMS),
 * 但 publish-pacing.ts 又原样复制了一份且没 import —— 两份各活各的。现已上收到
 * services/platforms/capabilities.ts 的 publishVia 维度, 本文件不再定义, 只消费。
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { agentPublishTasks, agentDevices } from "../../models/schema.js";
import { buildPushCaptions } from "./draft-push.js";
import { logger } from "../../config/logger.js";

// 6-19: video 内容的 body 有时混入 HTML 尾注(如"本文由 AI 辅助生成"声明), 直接当视频源会 404。
// 这里只从 body 里抽出视频 URL(/storage/...或 http...的 .mp4/.mov 等), 不信任整个 body。
function extractVideoUrl(body: string | null | undefined): string | null {
  if (!body) return null;
  const s = String(body).trim();
  const m = s.match(/(\/storage\/\S+?\.(?:mp4|mov|m4v|webm))/i)
        || s.match(/(https?:\/\/\S+?\.(?:mp4|mov|m4v|webm))/i);
  if (m) return m[1];
  // 兜底: 整个 body 就是个干净的 /storage 或 http 地址(无后缀/无HTML)
  if (/^\/storage\/\S+$/.test(s) && !/[<>\s]/.test(s)) return s;
  if (/^https?:\/\/\S+$/.test(s) && !/[<>\s]/.test(s)) return s;
  return null;
}

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
  const videoSource = content.type === "video" ? extractVideoUrl(content.body) : null;
  if (!videoSource) throw new Error("内容不是视频, 或 body 里没找到有效视频地址(/storage 或 http 的 .mp4) — 无法派单给本地 Agent");
  // 6-17 #8: 没有已配对的 active 设备就别空建任务(否则前端报"等待领取"实则石沉大海, 任务永远无人领)
  const [dev] = await db.select({ id: agentDevices.id }).from(agentDevices)
    .where(and(eq(agentDevices.tenantId, tenantId), eq(agentDevices.status, "active"))).limit(1);
  if (!dev) throw new Error("没有已配对的 Agent 设备 — 请先在客户电脑启动并配对 Agent，再发布抖音/视频号");
  const { captions, titles } = await buildPushCaptions(content.id, tenantId, accounts);
  // 6-19 #1 提前排查违规: 每条文案过合规检测 —— 硬词(封号级:政治/违法)直接拦截不发; 软词(广告法绝对化/医疗红线 → 降权风险)记警告放行。
  const { checkCompliance } = await import("../compliance/content-check.js");
  for (let i = 0; i < accounts.length; i++) {
    const text = `${titles[i] ?? content.title ?? ""}\n${captions[i] ?? ""}`;
    const c = await checkCompliance(text);
    if (c.blocked) {
      throw new Error(`派单已拦截: 文案含封号级违禁词「${c.hardHits.join("、")}」, 请修改文案后再发(防账号被封)`);
    }
    if (c.softHits.length > 0) {
      logger.warn({ accountName: accounts[i].accountName, softHits: c.softHits }, "#1 派单文案含广告法/医疗红线词 — 放行但有降权风险, 建议调整文案模板避免这些词");
    }
  }
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
