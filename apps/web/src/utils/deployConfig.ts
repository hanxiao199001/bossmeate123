/**
 * 部署相关的常量 —— 一律来自构建期环境变量，不写死在源码里。
 *
 * 为什么：本仓库是公开仓库，源码里写死生产服务器地址等于把它公开发布。
 * 变量放 `apps/web/.env.local`，必须 VITE_ 前缀，改完要重新 build。
 */

/**
 * 微信公众平台 IP 白名单要填的服务器 IP，展示给客户看。
 *
 * 未配置时不编造、也不留空格子，直接标注无数据（红线 #14：
 * 兜底不许产出与真数据同形态的文案）。
 */
export const WECHAT_WHITELIST_IP =
  import.meta.env.VITE_WECHAT_WHITELIST_IP || "见部署配置（未配置 VITE_WECHAT_WHITELIST_IP）";
