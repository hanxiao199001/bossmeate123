/**
 * 5-21 P0 — 左 sidebar 全 nav 项，active 高亮。
 * 6-11 UI 升级: 深色质感重做 — bg-slate-900 / w-52 / SVG 图标 (Icons.tsx) /
 * 分组标签替代分割线 / 底部头像用户区。导航数据与路由逻辑不动。
 * TODO: 移动响应式 (< 768px 折叠成 hamburger), 本 demo Mac only 暂不做。
 */
import type { ComponentType } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuthStore } from "../../hooks/useAuthStore";
import { SALES_RADAR_ENABLED } from "../../utils/featureFlags";
import {
  IconHome,
  IconPenSquare,
  IconFolder,
  IconRadar,
  IconSmartphone,
  IconCoins,
  IconSettings,
  IconBarChart,
  IconLogOut,
  type IconProps,
} from "../ui/Icons";

interface NavItem {
  to: string;
  icon: ComponentType<IconProps>;
  label: string;
  matchPrefix?: string;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", icon: IconHome, label: "首页", matchPrefix: "" }, // 精确匹配 / 即可
  { to: "/workbench", icon: IconPenSquare, label: "内容工坊", matchPrefix: "/workbench" },
  { to: "/content", icon: IconFolder, label: "内容管理", matchPrefix: "/content" },
  { to: "/sales-radar", icon: IconRadar, label: "销售雷达", matchPrefix: "/sales-radar" },
  { to: "/accounts", icon: IconSmartphone, label: "账号", matchPrefix: "/accounts" },
];

const SECONDARY_NAV: NavItem[] = [
  { to: "/cost-comparison", icon: IconCoins, label: "ROI 演示", matchPrefix: "/cost-comparison" },
  { to: "/settings", icon: IconSettings, label: "设置", matchPrefix: "/settings" },
];

// admin only (owner/admin role)，PR #111 期刊审计入口从 DashboardPage 搬来
const ADMIN_NAV: NavItem[] = [
  { to: "/admin/journals/audit", icon: IconBarChart, label: "期刊审计", matchPrefix: "/admin/journals/audit" },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.to === "/") return pathname === "/";
  return pathname === item.to || (!!item.matchPrefix && pathname.startsWith(item.matchPrefix + "/"));
}

function NavLinkItem({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={`relative flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? "bg-white/10 text-white font-medium"
          : "text-slate-400 hover:text-white hover:bg-white/5"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-indigo-400" aria-hidden />
      )}
      <Icon size={16} className="shrink-0" />
      <span>{item.label}</span>
    </Link>
  );
}

export default function Sidebar() {
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const role = user?.role;
  const isAdmin = role === "owner" || role === "admin";
  const secondaryNav = isAdmin ? [...SECONDARY_NAV, ...ADMIN_NAV] : SECONDARY_NAV;
  // 6-11 销售板块藏而不删(见 utils/featureFlags.ts)
  const primaryNav = SALES_RADAR_ENABLED ? PRIMARY_NAV : PRIMARY_NAV.filter((i) => i.to !== "/sales-radar");

  return (
    <aside className="fixed top-0 left-0 z-30 h-screen w-52 bg-slate-900 flex flex-col">
      {/* logo */}
      <div className="px-5 pt-5 pb-4">
        <Link to="/" className="block">
          <div className="text-base font-semibold tracking-tight text-white">BossMate</div>
          <div className="text-[10px] text-slate-500 mt-0.5">AI 超级员工</div>
        </Link>
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-3">
        <div className="px-3 mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">工作台</div>
        <ul className="space-y-0.5">
          {primaryNav.map((item) => (
            <li key={item.to}>
              <NavLinkItem item={item} active={isActive(pathname, item)} />
            </li>
          ))}
        </ul>

        <div className="px-3 mt-5 mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">管理</div>
        <ul className="space-y-0.5">
          {secondaryNav.map((item) => (
            <li key={item.to}>
              <NavLinkItem item={item} active={isActive(pathname, item)} />
            </li>
          ))}
        </ul>
      </nav>

      {/* 底部用户 */}
      <div className="border-t border-white/10 px-4 py-3 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-indigo-600 text-white text-xs font-medium flex items-center justify-center shrink-0">
          {(user?.name || "—").slice(0, 1)}
        </div>
        <div className="text-xs text-slate-300 font-medium truncate flex-1" title={user?.name}>
          {user?.name || "—"}
        </div>
        <button
          onClick={logout}
          className="text-slate-500 hover:text-rose-400 transition-colors shrink-0 p-1"
          title="退出"
          aria-label="退出"
        >
          <IconLogOut size={14} />
        </button>
      </div>
    </aside>
  );
}
