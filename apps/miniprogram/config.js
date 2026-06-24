// 全局配置 —— 部署前请修改 API_BASE 为你的线上域名
// 注意：微信小程序后台「开发管理 → 服务器域名 → request 合法域名」必须加入该域名（https）。
module.exports = {
  // 线上 BossMate 服务器，含 /api/v1 前缀
  // API 与前台同域，nginx 把 /api/ 反代到后端（无 api. 子域名）
  API_BASE: "https://boss-mate.cn/api/v1",

  // 本地开发时可在「详情 → 本地设置」勾选「不校验合法域名」后改成：
  // API_BASE: "http://localhost:3000/api/v1",

  // 缓存 key
  TOKEN_KEY: "bm_token",
  USER_KEY: "bm_user",
};
