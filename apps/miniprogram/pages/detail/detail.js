const { request } = require("../../utils/request.js");
const fmt = require("../../utils/format.js");

Page({
  data: {
    id: "",
    journal: null,
    loading: true,
    error: "",
  },

  onLoad(query) {
    const id = query.id || "";
    this.setData({ id });
    if (!id) {
      this.setData({ loading: false, error: "缺少期刊 ID" });
      return;
    }
    this.fetch();
  },

  fetch() {
    request({ url: "/journals/" + this.data.id, method: "GET" })
      .then((j) => {
        this.setData({ journal: this.decorate(j), loading: false });
      })
      .catch((err) => {
        this.setData({ loading: false, error: err.message || "加载失败" });
      });
  },

  decorate(j) {
    return Object.assign({}, j, {
      _discipline: fmt.disciplineCn(j.discipline),
      _if: fmt.ifText(j.impactFactor),
      _rate: fmt.rateText(j.acceptanceRate),
    });
  },

  copyIssn() {
    const issn = this.data.journal && this.data.journal.issn;
    if (!issn) return;
    wx.setClipboardData({ data: issn });
  },

  openWebsite() {
    const url = this.data.journal && this.data.journal.website;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success() {
        wx.showToast({ title: "官网链接已复制", icon: "none" });
      },
    });
  },
});
