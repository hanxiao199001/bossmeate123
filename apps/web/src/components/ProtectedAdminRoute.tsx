/**
 * Day 2 PR B: admin 路由守卫 — 仅 owner / admin 可进。
 * 普通 member / editor 直接踢回 /，避免渲染敏感数据后再 401。
 */
import { Navigate } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";

export default function ProtectedAdminRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const role = useAuthStore((s) => s.user?.role);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (role !== "owner" && role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}
