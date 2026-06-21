/**
 * 6-20 按角色落地: 不同角色登录后进各自工作台, 避免运营/销售落在老板驾驶舱(会调 admin 接口报 403)。
 *   owner/admin → 驾驶舱 /  ·  运营 → /workbench  ·  销售 → /sales-radar  ·  财务 → /cost-comparison
 */
interface UserLike {
  role?: string;
  permissions?: string[];
}

export function roleHomePath(user?: UserLike | null): string {
  const role = user?.role;
  const perms = user?.permissions ?? [];
  // owner/admin(或显式有全局看板权限)→ 驾驶舱
  if (role === "owner" || role === "admin" || perms.includes("dashboard.read_all")) return "/";
  if (perms.includes("content.read")) return "/workbench";
  if (perms.includes("sales.read_all") || perms.includes("sales.read_assigned")) return "/sales-radar";
  if (perms.includes("analytics.read")) return "/cost-comparison";
  return "/workbench"; // 兜底
}

/** 是否应进老板驾驶舱(决定 "/" 渲染 TodayPage 还是跳转)。 */
export function isBossHome(user?: UserLike | null): boolean {
  return roleHomePath(user) === "/";
}
