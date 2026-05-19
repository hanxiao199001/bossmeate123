/**
 * 5-21 P0 — 左 sidebar 160px 全 nav 项，active 高亮。
 * TODO: 移动响应式 (< 768px 折叠成 hamburger), 本 demo Mac only 暂不做。
 */
import { Link, useLocation } from "react-router-dom";
import { useAuthStore } from "../../hooks/useAuthStore";

interface NavItem {
  to: string;
  icon: string;
  label: string;
  matchPrefix?: string;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", icon: "🏠", label: "首页", matchPrefix: "" }, // 精确匹配 / 即可
  { to: "/workbench", icon: "📝", label: "内容工坊", matchPrefix: "/workbench" },
  { to: "/content", icon: "📂", label: "内容管理", matchPrefix: "/content" },
  { to: "/sales-radar", icon: "📡", label: "销售雷达", matchPrefix: "/sales-radar" },
  { to: "/accounts", icon: "📱", label: "账号", matchPrefix: "/accounts" },
];

const SECONDARY_NAV: NavItem[] = [
  { to: "/cost-comparison", icon: "💰", label: "ROI 演示", matchPrefix: "/cost-comparison" },
  { to: "/settings", icon: "⚙️", label: "设置", matchPrefix: "/settings" },
];

// admin only (owner/admin role)，PR #111 期刊审计入口从 DashboardPage 搬来
const ADMIN_NAV: NavItem[] = [
  { to: "/admin/journals/audit", icon: "📊", label: "期刊审计", matchPrefix: "/admin/journals/audit" },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.to === "/") return pathname === "/";
  return pathname === item.to || (!!item.matchPrefix && pathname.startsWith(item.matchPrefix + "/"));
}

export default function Sidebar() {
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const role = user?.role;
  const isAdmin = role === "owner" || role === "admin";
  const secondaryNav = isAdmin ? [...SECONDARY_NAV, ...ADMIN_NAV] : SECONDARY_NAV;

  return (
    <aside className="fixed top-0 left-0 z-30 h-screen w-40 bg-white border-r border-gray-200 flex flex-col">
      {/* logo */}
      <div className="px-4 py-4 border-b border-gray-100">
        <Link to="/" className="block">
          <div className="text-base font-bold text-blue-600">BossMate</div>
          <div className="text-[10px] text-gray-400 mt-0.5">AI 超级员工</div>
        </Link>
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        <ul className="space-y-0.5">
          {PRIMARY_NAV.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? "bg-blue-50 text-blue-700 font-medium"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-gray-100 my-3" />

        <ul className="space-y-0.5">
          {secondaryNav.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ${
                    active
                      ? "bg-blue-50 text-blue-700 font-medium"
                      : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  <span className="text-sm">{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* 底部用户 */}
      <div className="border-t border-gray-100 px-3 py-3">
        <div className="text-xs text-gray-700 font-medium truncate" title={user?.name}>{user?.name || "—"}</div>
        <button onClick={logout} className="mt-1 text-[11px] text-gray-400 hover:text-red-500">退出</button>
      </div>
    </aside>
  );
}
