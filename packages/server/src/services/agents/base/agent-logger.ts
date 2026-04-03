/**
 * Agent 执行日志工具
 */

import { db } from "../../../models/db.js";
import { agentLogs } from "../../../models/schema.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export async function logAgentAction(params: {
  tenantId: string;
  agentName: string;
  action: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  tokensUsed?: number;
}): Promise<string> {
  const id = nanoid(16);
  await db.insert(agentLogs).values({
    id,
    tenantId: params.tenantId,
    agentName: params.agentName,
    action: params.action,
    status: params.status,
    input: params.input as any,
    output: params.output as any,
    error: params.error,
    durationMs: params.durationMs,
    tokensUsed: params.tokensUsed,
  });
  return id;
}

export async function updateAgentLog(
  id: string,
  updates: Partial<{
    status: string;
    output: unknown;
    error: string;
    durationMs: number;
    tokensUsed: number;
  }>
): Promise<void> {
  await db
    .update(agentLogs)
    .set(updates as any)
    .where(eq(agentLogs.id, id));
}
