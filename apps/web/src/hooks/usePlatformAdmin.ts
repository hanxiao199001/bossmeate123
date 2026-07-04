/**
 * 7-05 多租户开通 P0: 当前登录用户是否平台管理员(手机号在 PLATFORM_ADMIN_PHONES 白名单)。
 * 调 GET /platform/me, 模块级缓存(登录期内只查一次); 登出清缓存。
 * Sidebar 用它决定是否显示「平台管理」入口, PlatformPage 用它做页面守卫。
 */
import { useEffect, useState } from "react";
import { api } from "../utils/api";
import { useAuthStore } from "./useAuthStore";

let cached: boolean | null = null;
let cachedToken: string | null = null;

export function usePlatformAdmin(): { isPlatformAdmin: boolean; checked: boolean } {
  const token = useAuthStore((s) => s.token);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const valid = cachedToken === token && cached !== null;
  const [state, setState] = useState<{ isPlatformAdmin: boolean; checked: boolean }>(
    valid ? { isPlatformAdmin: !!cached, checked: true } : { isPlatformAdmin: false, checked: false },
  );

  useEffect(() => {
    if (!isAuthenticated || !token) {
      cached = null;
      cachedToken = null;
      setState({ isPlatformAdmin: false, checked: true });
      return;
    }
    if (cachedToken === token && cached !== null) {
      setState({ isPlatformAdmin: cached, checked: true });
      return;
    }
    let alive = true;
    api
      .get<{ isPlatformAdmin: boolean }>("/platform/me")
      .then((r) => {
        cached = !!r.data?.isPlatformAdmin;
        cachedToken = token;
        if (alive) setState({ isPlatformAdmin: cached, checked: true });
      })
      .catch(() => {
        // 老后端没有 /platform/me 或网络异常 → 视为非平台管理员, 不打扰用户
        cached = false;
        cachedToken = token;
        if (alive) setState({ isPlatformAdmin: false, checked: true });
      });
    return () => { alive = false; };
  }, [isAuthenticated, token]);

  return state;
}
