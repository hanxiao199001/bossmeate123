const { request } = require("../../utils/request.js");
const fmt = require("../../utils/format.js");

Page({
  data: {
    abstract: "",
    len: 0,
    matches: [],
    loading: false,
    searched: false,
  },

  onAbstract(e) {
    const v = e.detail.value;
    this.setData({ abstract: v, len: v.length });
  },

  onMatch() {
    const text = this.data.abstract.trim();
    if (text.length < 50) {
      wx.showToast({ title: "摘要至少 50 字", icon: "none" });
      return;
    }
    if (text.length > 3000) {
      wx.showToast({ title: "摘要不超过 3000 字", icon: "none" });
      return;
    }
    this.setData({ loading: true, matches: [], searched: false });

    // 公开接口，无需登录
    request({
      url: "/public/match-journals",
      method: "POST",
      data: { abstract: text },
      auth: false,
      raw: true,
    })
      .then((body) => {
        const matches = (body.matches || []).map((m) => ({
          name: m.name,
          discipline: m.discipline || "",
          partition: m.partition || "",
          impactFactor: m.impactFactor || 0,
          _if: fmt.ifText(m.impactFactor),
          reason: m.reason || "",
        }));
        this.setData({ matches, loading: false, searched: true });
      })
      .catch((err) => {
        this.setData({ loading: false, searched: true });
        wx.showToast({ title: err.message || "匹配失败", icon: "none" });
      });
  },

  clear() {
    this.setData({ abstract: "", len: 0, matches: [], searched: false });
  },
});
