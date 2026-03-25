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

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  tenant: null,
  isAuthenticated: false,

  login: (token, user, tenant) => {
    set({ token, user, tenant, isAuthenticated: true });
  },

  logout: () => {
    set({ token: null, user: null, tenant: null, isAuthenticated: false });
  },

  setTenant: (tenant) => {
    set({ tenant });
  },
}));
