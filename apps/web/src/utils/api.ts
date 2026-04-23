/**
 * API 请求工具
 * - 自动携带 JWT Token
 * - 统一错误处理（带 toast）
 * - 支持 AbortController（传 options.signal）
 * - 401 不再硬跳转，改为 logout + 派发自定义事件，让页面自行决定如何挽救
 */

import { useAuthStore } from "../hooks/useAuthStore";
import { toast } from "../components/Toast";

const API_BASE = "/api/v1";

export interface ApiResponse<T = unknown> {
  code: string;
  data?: T;
  message?: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  data?: unknown;

  constructor(message: string, code: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export class ApiAbortError extends Error {
  constructor() {
    super("请求已取消");
    this.name = "ApiAbortError";
  }
}

/** 并发多请求一起 401 时只提示一次 */
let unauthorizedNotified = false;

function notifyUnauthorized() {
  if (unauthorizedNotified) return;
  unauthorizedNotified = true;
  setTimeout(() => { unauthorizedNotified = false; }, 1000);

  toast.warning("登录已过期，请重新登录");
  useAuthStore.getState().logout();
  // ProtectedRoute 监听 isAuthenticated 会自动跳回 /login；
  // 同时派发事件，页面可监听并保存未提交的编辑。
  window.dispatchEvent(new CustomEvent("bossmate:unauthorized"));
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = useAuthStore.getState().token;

  // 仅当有请求体时才设 Content-Type
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (options.body != null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiAbortError();
    }
    toast.error("网络连接失败，请检查网络");
    throw error;
  }

  let data: ApiResponse<T>;
  try {
    const text = await response.text();
    data = text
      ? (JSON.parse(text) as ApiResponse<T>)
      : ({ code: "EMPTY" } as ApiResponse<T>);
  } catch {
    data = {
      code: "PARSE_ERROR",
      message: `服务器返回异常 (HTTP ${response.status})`,
    };
  }

  if (!response.ok) {
    if (response.status === 401) {
      notifyUnauthorized();
    } else {
      const errorMessage = data.message || `请求失败 (${response.status})`;
      toast.error(errorMessage);
    }
    throw new ApiError(
      data.message || `请求失败 (${response.status})`,
      data.code || "HTTP_ERROR",
      response.status,
      data.data
    );
  }

  return data;
}

type ReqInit = Omit<RequestInit, "body" | "method">;

export const api = {
  get: <T>(path: string, init: ReqInit = {}) =>
    request<T>(path, { ...init, method: "GET" }),

  post: <T>(path: string, body: unknown, init: ReqInit = {}) =>
    request<T>(path, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    }),

  patch: <T>(path: string, body: unknown, init: ReqInit = {}) =>
    request<T>(path, {
      ...init,
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  put: <T>(path: string, body: unknown, init: ReqInit = {}) =>
    request<T>(path, {
      ...init,
      method: "PUT",
      body: JSON.stringify(body),
    }),

  delete: <T>(path: string, init: ReqInit = {}) =>
    request<T>(path, { ...init, method: "DELETE" }),
};
