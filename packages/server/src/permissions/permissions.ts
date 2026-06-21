/**
 * 6-20 多租户角色权限地基(租户层 RBAC)。
 *   能力(Permission)而非角色硬编码 —— 路由按 Permission 拦截, 角色→权限集在此集中定义。
 *   后端强制鉴权(requirePermission 中间件), 前端隐藏菜单只是体验, 不是安全边界。
 *
 *   ⚠️ 向后兼容: 现网存量用户 role 多为 "member"(schema 默认值)。若不给 member 映射权限,
 *   权限中间件一上线老员工会被全锁死。这里把 member 等价为 content_operator(内容运营),
 *   保证老用户行为不变; 新体系用明确角色, 存量可后续逐步迁移。
 */

/** 租户内角色。member 为历史默认值(兼容), 新建用明确角色。 */
export type UserRole =
  | "owner" // 老板, 最高权限
  | "admin" // 管理员, 协助配置
  | "content_operator" // 内容运营
  | "sales_director" // 销售总监
  | "sales" // 销售人员
  | "finance_viewer" // 财务/成本查看
  | "member"; // 历史默认角色(兼容 = content_operator)

export type Permission =
  | "dashboard.read_all"
  | "members.manage"
  | "settings.manage"
  | "content.read"
  | "content.write"
  | "content.publish"
  | "accounts.read"
  | "accounts.manage"
  | "sales.read_all"
  | "sales.read_assigned"
  | "sales.write_all"
  | "sales.write_assigned"
  | "sales.assign"
  | "analytics.read"
  | "billing.read";

const CONTENT_OPERATOR_PERMS: Permission[] = [
  "content.read",
  "content.write",
  "content.publish",
  "accounts.read",
  "accounts.manage",
  "analytics.read",
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [
    "dashboard.read_all",
    "members.manage",
    "settings.manage",
    "content.read",
    "content.write",
    "content.publish",
    "accounts.read",
    "accounts.manage",
    "sales.read_all",
    "sales.write_all",
    "sales.assign",
    "analytics.read",
    "billing.read",
  ],
  admin: [
    "dashboard.read_all",
    "members.manage",
    "settings.manage",
    "content.read",
    "content.write",
    "content.publish",
    "accounts.read",
    "accounts.manage",
    "sales.read_all",
    "analytics.read",
  ],
  content_operator: CONTENT_OPERATOR_PERMS,
  sales_director: ["sales.read_all", "sales.write_all", "sales.assign", "analytics.read"],
  sales: ["sales.read_assigned", "sales.write_assigned"],
  finance_viewer: ["analytics.read", "billing.read"],
  // 兼容: 存量 member 等价内容运营, 老用户不被锁死。
  member: CONTENT_OPERATOR_PERMS,
};

/** 角色是否拥有某权限。未知角色一律无权限(安全默认)。 */
export function hasPermission(role: string | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role as UserRole];
  return Array.isArray(perms) && perms.includes(permission);
}

/** 取角色的全部权限(登录时返回前端用于菜单显示; 前端仅用于体验, 不作安全依据)。 */
export function permissionsForRole(role: string | undefined | null): Permission[] {
  if (!role) return [];
  return ROLE_PERMISSIONS[role as UserRole] ?? [];
}
