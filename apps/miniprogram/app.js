const config = require("./config.js");

App({
  globalData: {
    token: "",
    user: null,
  },

  onLaunch() {
    // 启动时恢复登录态
    try {
      const token = wx.getStorageSync(config.TOKEN_KEY);
      const user = wx.getStorageSync(config.USER_KEY);
      if (token) this.globalData.token = token;
      if (user) this.globalData.user = user;
    } catch (e) {
      // ignore
    }
  },

  // 是否已登录
  isLoggedIn() {
    return !!this.globalData.token;
  },

  // 保存登录态
  setSession(token, user) {
    this.globalData.token = token || "";
    this.globalData.user = user || null;
    wx.setStorageSync(config.TOKEN_KEY, token || "");
    wx.setStorageSync(config.USER_KEY, user || null);
  },

  // 退出登录
  clearSession() {
    this.globalData.token = "";
    this.globalData.user = null;
    wx.removeStorageSync(config.TOKEN_KEY);
    wx.removeStorageSync(config.USER_KEY);
  },
});
