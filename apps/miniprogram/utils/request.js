const config = require("../config.js");

/**
 * 统一请求封装
 * - 自动带上 Authorization: Bearer <token>
 * - 401 时清登录态并跳登录页
 * - 返回 Promise，resolve 的是后端 data 字段（或整体）
 *
 * @param {Object} opts
 * @param {string} opts.url       相对路径，如 "/journals"
 * @param {string} [opts.method]  GET/POST...
 * @param {Object} [opts.data]    body 或 query
 * @param {boolean} [opts.auth]   是否需要登录态（默认 true）
 * @param {boolean} [opts.raw]    true 时返回完整响应体，不剥 data
 */
function request(opts) {
  const app = getApp();
  const method = (opts.method || "GET").toUpperCase();
  const needAuth = opts.auth !== false;

  return new Promise((resolve, reject) => {
    const header = { "Content-Type": "application/json" };
    const token = app && app.globalData.token;
    if (token) header.Authorization = "Bearer " + token;

    if (needAuth && !token) {
      redirectToLogin();
      reject(new Error("NOT_LOGGED_IN"));
      return;
    }

    wx.request({
      url: config.API_BASE + opts.url,
      method,
      data: opts.data || {},
      header,
      timeout: 20000,
      success(res) {
        const status = res.statusCode;
        const body = res.data || {};

        if (status === 401) {
          if (app) app.clearSession();
          redirectToLogin();
          reject(new Error(body.message || "登录已过期"));
          return;
        }

        if (status >= 200 && status < 300) {
          // 后端约定: { code: "ok"|"OK", data: {...} }；公开接口直接返回 { matches }
          if (opts.raw) return resolve(body);
          if (body && Object.prototype.hasOwnProperty.call(body, "data")) {
            return resolve(body.data);
          }
          return resolve(body);
        }

        reject(new Error(body.message || body.error || `请求失败(${status})`));
      },
      fail(err) {
        reject(new Error(err.errMsg || "网络异常"));
      },
    });
  });
}

function redirectToLogin() {
  const pages = getCurrentPages();
  const cur = pages.length ? pages[pages.length - 1].route : "";
  if (cur && cur.indexOf("pages/login/login") !== -1) return;
  wx.navigateTo({ url: "/pages/login/login" });
}

module.exports = { request };
