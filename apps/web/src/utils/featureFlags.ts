/**
 * 前端功能开关(构建期, 6-11)
 *
 * SALES_RADAR_ENABLED — 销售板块"藏而不删"开关(老韩 6-11 拍板):
 *   销售模块未正式开发(二期重点), 默认整体隐藏(侧边栏菜单/首页CTA/待跟进客户卡/销售KPI),
 *   不挂"开发中"标签以免显得半成品。路由本体保留, 直接敲 /sales-radar 仍可达(开发用)。
 *   打开方式: apps/web/.env.local 写 VITE_SALES_RADAR_ENABLED=true 后重新 build
 *   (演示版/二期开发时打开, 整套界面原样回归)。
 */
export const SALES_RADAR_ENABLED = import.meta.env.VITE_SALES_RADAR_ENABLED === "true";
