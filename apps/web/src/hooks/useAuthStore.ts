import { create } from "zustand";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  tenant: Tenant | null;
  isAuthenticated: boolean;

  login: (token: string, user: User, tenant?: Tenant) => void;
  logout: () => void;
  setTenant: (tenant: Tenant) => void;
}

// 从 localStorage 恢复登录状态
function getInitialState() {
  try {
    const saved = localStorage.getItem("bossmate_auth");
    if (saved) {
      const data = JSON.parse(saved);
      return {
        token: data.token || null,
        user: data.user || null,
        tenant: data.tenant || null,
        isAuthenticated: !!data.token,
      };
    }
  } catch {
    // ignore
  }
  return { token: null, user: null, tenant: null, isAuthenticated: false };
}

export const useAuthStore = create<AuthState>((set) => ({
  ...getInitialState(),

  login: (token, user, tenant) => {
    localStorage.setItem("bossmate_auth", JSON.stringify({ token, user, tenant }));
    set({ token, user, tenant, isAuthenticated: true });
  },

  logout: () => {
    localStorage.removeItem("bossmate_auth");
    set({ token: null, user: null, tenant: null, isAuthenticated: false });
  },

  setTenant: (tenant) => {
    const current = JSON.parse(localStorage.getItem("bossmate_auth") || "{}");
    localStorage.setItem("bossmate_auth", JSON.stringify({ ...current, tenant }));
    set({ tenant });
  },
}));
