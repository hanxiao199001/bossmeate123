/**
 * 服务端 /api/v1/agent/* 接口封装 (契约见 packages/server/src/routes/agent.ts):
 *   POST /agent/pair {code,name,version}     配对码换 token (无需 token)
 *   GET  /agent/ping                          心跳
 *   GET  /agent/accounts                      可本地发布的账号列表
 *   POST /agent/tasks/claim {platforms,limit} 原子领单
 *   GET  /agent/tasks/:id/video               视频下载 (流式写盘; 服务端可能 302 外链)
 *   POST /agent/tasks/:id/result {status,error} 结果回报
 * 鉴权: x-agent-token 请求头。
 */
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface AgentAccount {
  id: string;
  platform: string;
  accountName: string;
  status: string;
}

export interface AgentTask {
  id: string;
  contentId: string;
  accountId: string;
  platform: string;
  accountName: string;
  videoSource: string;
  caption: string | null;
  title: string | null;
  attempts: number;
}

export type ResultStatus = "success" | "failed" | "login_expired" | "manual_pending";

/** 带 HTTP 状态码与服务器 message 的错误 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function apiBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "") + "/api/v1";
}

async function toApiError(resp: Response): Promise<ApiError> {
  let message = `HTTP ${resp.status} ${resp.statusText}`;
  try {
    const body = (await resp.json()) as { message?: string; code?: string };
    if (body?.message) message = `HTTP ${resp.status}: ${body.message}`;
  } catch { /* 非 JSON 响应, 用状态行 */ }
  return new ApiError(resp.status, message);
}

export class AgentApi {
  private readonly base: string;

  constructor(serverUrl: string, private readonly token: string) {
    this.base = apiBase(serverUrl);
  }

  /** 配对 (唯一不带 token 的接口), 成功返回明文 token — 只出现这一次, 立刻存盘 */
  static async pair(
    serverUrl: string,
    code: string,
    name: string,
    version: string,
  ): Promise<{ token: string; deviceId: string; tenantId: string }> {
    const resp = await fetch(`${apiBase(serverUrl)}/agent/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name, version }),
    });
    if (!resp.ok) throw await toApiError(resp);
    const body = (await resp.json()) as { data: { token: string; deviceId: string; tenantId: string } };
    return body.data;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const headers: Record<string, string> = { "x-agent-token": this.token };
    let bodyText: string | undefined;
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      bodyText = JSON.stringify(init.body);
    }
    const resp = await fetch(this.base + path, {
      method: init?.method ?? "GET",
      headers,
      body: bodyText,
    });
    if (!resp.ok) throw await toApiError(resp);
    return (await resp.json()) as T;
  }

  async ping(): Promise<{ ok: boolean; serverTime: string; deviceId: string }> {
    return this.request<{ ok: boolean; serverTime: string; deviceId: string }>("/agent/ping");
  }

  async listAccounts(): Promise<AgentAccount[]> {
    const body = await this.request<{ data: { accounts: AgentAccount[] } }>("/agent/accounts");
    return body.data.accounts;
  }

  async claimTasks(platforms: string[], limit = 1): Promise<AgentTask[]> {
    const body = await this.request<{ data: { tasks: AgentTask[] } }>("/agent/tasks/claim", {
      method: "POST",
      body: { platforms, limit },
    });
    return body.data.tasks;
  }

  /** 视频流式写盘 (服务端 /storage/ 文件直接回传; 外链 302 由 fetch 自动跟随) */
  async downloadVideo(taskId: string, destPath: string): Promise<void> {
    const resp = await fetch(`${this.base}/agent/tasks/${taskId}/video`, {
      headers: { "x-agent-token": this.token },
      redirect: "follow",
    });
    if (!resp.ok) throw await toApiError(resp);
    if (!resp.body) throw new ApiError(resp.status, "视频响应无内容");
    await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(destPath));
  }

  async reportResult(taskId: string, status: ResultStatus, error?: string): Promise<void> {
    await this.request(`/agent/tasks/${taskId}/result`, {
      method: "POST",
      body: { status, error },
    });
  }
}
