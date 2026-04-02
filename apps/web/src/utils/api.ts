/**
 * API 请求工具
 * 自动携带 JWT Token，统一错误处理
 */

import { useAuthStore } from "../hooks/useAuthStore";

const API_BASE = "/api/v1";

interface ApiResponse<T = unknown> {
  code: string;
  data?: T;
  message?: string;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = useAuthStore.getState().token;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  let data: any;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { code: "PARSE_ERROR", message: `服务器返回异常 (HTTP ${response.status})` };
  }

  if (!response.ok) {
    // 401 自动登出
    if (response.status === 401) {
      useAuthStore.getState().logout();
    }
    throw new Error(data.message || `请求失败 (${response.status})`);
  }

  return data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),

  post: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  patch: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  put: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  delete: <T>(path: string) =>
    request<T>(path, { method: "DELETE" }),
};
