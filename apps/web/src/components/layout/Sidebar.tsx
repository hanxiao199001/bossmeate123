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
  IconRadar,
  IconSmartphone,
  IconSettings,
  IconBarChart,
  IconFileText,
  IconUsers,
  IconLogOut,
  type IconProps,
} from "../ui/Icons";

interface NavItem {
  to: string;
  icon: ComponentType<IconProps>;
  label: string;
  matchPrefix?: string;
  adminOnly?: boolean; // owner/admin 才显示
  anyPerms?: string[]; // 6-20: 拥有其中任一权限才显示(按角色)
}

// 6-14 目录重构: 按首页"产出→处理→效果"日常闭环分三组, 心智模型与首页引导对齐。
// 每日运营 — 日常内容生产闭环
const DAILY_NAV: NavItem[] = [
  { to: "/", icon: IconHome, label: "今日", matchPrefix: "" }, // 6-16 首页=今日驾驶舱(合并原首页+今日待办), 精确匹配 /
  { to: "/workbench", icon: IconPenSquare, label: "内容工坊", matchPrefix: "/workbench", anyPerms: ["content.read"] },
  { to: "/sales-radar", icon: IconRadar, label: "销售雷达", matchPrefix: "/sales-radar", anyPerms: ["sales.read_all", "sales.read_assigned"] },
  { to: "/accounts", icon: IconSmartphone, label: "账号矩阵", matchPrefix: "/accounts", anyPerms: ["accounts.read"] }, // 对齐首页"去账号矩阵派发"
];

// 效果与数据 — 看效果 + 核心数据资产
const DATA_NAV: NavItem[] = [
  { to: "/cost-comparison", icon: IconBarChart, label: "效果分析", matchPrefix: "/cost-comparison", anyPerms: ["analytics.read"] }, // 原"ROI演示"
  { to: "/admin/journals/audit", icon: IconFileText, label: "期刊审计", matchPrefix: "/admin/journals/audit", adminOnly: true }, // 核心数据资产, 从admin底部提上来
];

// 系统 — 配置与 ToB 开通
const SYSTEM_NAV: NavItem[] = [
  { to: "/settings", icon: IconSettings, label: "设置", matchPrefix: "/settings" },
  { to: "/onboarding", icon: IconUsers, label: "客户开通", matchPrefix: "/onboarding", adminOnly: true }, // 独立图标(原与今日撞Sparkles)
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
  const perms = user?.permissions ?? [];
  // 6-20: owner 旧 token 可能没带 permissions → 视为全权, 避免老登录态被清空菜单
  const allowAll = perms.length === 0 && isAdmin;
  const hasAny = (req?: string[]) => !req || req.length === 0 || allowAll || req.some((p) => perms.includes(p));
  // 统一过滤: adminOnly 项非管理员隐藏; anyPerms 按角色权限; 销售雷达受 feature flag 控制(藏而不删)
  const visible = (items: NavItem[]) =>
    items.filter((i) => {
      if (i.adminOnly && !isAdmin) return false;
      if (!hasAny(i.anyPerms)) return false;
      if (i.to === "/sales-radar" && !SALES_RADAR_ENABLED) return false;
      return true;
    });
  const dailyNav = visible(DAILY_NAV);
  const dataNav = visible(DATA_NAV);
  const systemNav = visible(SYSTEM_NAV);

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
        <div className="px-3 mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">每日运营</div>
        <ul className="space-y-0.5">
          {dailyNav.map((item) => (
            <li key={item.to}>
              <NavLinkItem item={item} active={isActive(pathname, item)} />
            </li>
          ))}
        </ul>

        {dataNav.length > 0 && (
          <>
            <div className="px-3 mt-5 mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">效果与数据</div>
            <ul className="space-y-0.5">
              {dataNav.map((item) => (
                <li key={item.to}>
                  <NavLinkItem item={item} active={isActive(pathname, item)} />
                </li>
              ))}
            </ul>
          </>
        )}

        {systemNav.length > 0 && (
          <>
            <div className="px-3 mt-5 mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">系统</div>
            <ul className="space-y-0.5">
              {systemNav.map((item) => (
                <li key={item.to}>
                  <NavLinkItem item={item} active={isActive(pathname, item)} />
                </li>
              ))}
            </ul>
          </>
        )}
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
