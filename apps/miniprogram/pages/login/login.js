const { request } = require("../../utils/request.js");

Page({
  data: {
    loading: false,
  },

  // 微信一键登录：wx.login 拿 code + getPhoneNumber 拿加密手机号 → 后端换 JWT
  onGetPhoneNumber(e) {
    if (e.detail.errMsg !== "getPhoneNumber:ok") {
      wx.showToast({ title: "已取消授权", icon: "none" });
      return;
    }
    const { encryptedData, iv, code: phoneCode } = e.detail;
    this.setData({ loading: true });

    wx.login({
      success: (res) => {
        if (!res.code) {
          this.setData({ loading: false });
          wx.showToast({ title: "登录失败，请重试", icon: "none" });
          return;
        }
        // 新版基础库走 phoneCode（手机号快速验证），同时把老版的 encryptedData/iv 一并带上做兼容
        request({
          url: "/auth/wx-login",
          method: "POST",
          auth: false,
          raw: true,
          data: {
            code: res.code,
            phoneCode: phoneCode || "",
            encryptedData: encryptedData || "",
            iv: iv || "",
          },
        })
          .then((body) => this.onLoginSuccess(body))
          .catch((err) => {
            this.setData({ loading: false });
            wx.showModal({
              title: "登录失败",
              content: err.message || "请稍后重试",
              showCancel: false,
            });
          });
      },
      fail: () => {
        this.setData({ loading: false });
        wx.showToast({ title: "微信登录失败", icon: "none" });
      },
    });
  },

  onLoginSuccess(body) {
    this.setData({ loading: false });
    const data = body && body.data ? body.data : body;
    const token = data && data.token;
    const user = data && data.user;
    if (!token) {
      wx.showToast({ title: "登录返回异常", icon: "none" });
      return;
    }
    getApp().setSession(token, user);
    wx.showToast({ title: "登录成功", icon: "success" });
    setTimeout(() => {
      // 回到上一页；没有上一页则进首页
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: "/pages/index/index" });
      }
    }, 600);
  },

  // 仅体验「智能匹配」（公开接口，无需登录）
  goMatch() {
    wx.switchTab({ url: "/pages/match/match" });
  },
});
