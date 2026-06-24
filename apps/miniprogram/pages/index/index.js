const { request } = require("../../utils/request.js");
const fmt = require("../../utils/format.js");

Page({
  data: {
    keyword: "",
    disciplineOptions: fmt.DISCIPLINE_OPTIONS,
    disciplineIndex: 0,
    partitionOptions: fmt.PARTITION_OPTIONS,
    partitionIndex: 0,
    sortOptions: fmt.SORT_OPTIONS,
    sortIndex: 0,
    ifMin: "",
    ifMax: "",
    list: [],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    noMore: false,
    loaded: false,
  },

  onShow() {
    // 进入页若未登录，引导登录（检索接口需要 JWT）
    const app = getApp();
    if (!app.isLoggedIn()) {
      wx.navigateTo({ url: "/pages/login/login" });
    }
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },
  onDiscipline(e) {
    this.setData({ disciplineIndex: Number(e.detail.value) });
  },
  onPartition(e) {
    this.setData({ partitionIndex: Number(e.detail.value) });
  },
  onSort(e) {
    this.setData({ sortIndex: Number(e.detail.value) });
  },
  onIfMin(e) {
    this.setData({ ifMin: e.detail.value });
  },
  onIfMax(e) {
    this.setData({ ifMax: e.detail.value });
  },

  // 点「搜索」从第一页开始
  onSearch() {
    this.setData({ page: 1, list: [], noMore: false }, () => this.fetch());
  },

  reset() {
    this.setData({
      keyword: "",
      disciplineIndex: 0,
      partitionIndex: 0,
      sortIndex: 0,
      ifMin: "",
      ifMax: "",
      list: [],
      total: 0,
      page: 1,
      noMore: false,
      loaded: false,
    });
  },

  buildQuery() {
    const d = this.data;
    const q = {
      page: d.page,
      pageSize: d.pageSize,
      sortBy: d.sortOptions[d.sortIndex].value,
    };
    if (d.keyword.trim()) q.keyword = d.keyword.trim();
    const disc = d.disciplineOptions[d.disciplineIndex].value;
    if (disc) q.discipline = disc;
    const part = d.partitionOptions[d.partitionIndex];
    if (part && part !== "不限") q.partition = part;
    if (d.ifMin !== "") q.ifMin = d.ifMin;
    if (d.ifMax !== "") q.ifMax = d.ifMax;
    return q;
  },

  fetch() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    request({ url: "/journals", method: "GET", data: this.buildQuery() })
      .then((data) => {
        const items = (data.items || []).map((j) => this.decorate(j));
        const merged = this.data.page === 1 ? items : this.data.list.concat(items);
        this.setData({
          list: merged,
          total: data.total || 0,
          loading: false,
          loaded: true,
          noMore: merged.length >= (data.total || 0),
        });
      })
      .catch((err) => {
        this.setData({ loading: false, loaded: true });
        if (err.message !== "NOT_LOGGED_IN") {
          wx.showToast({ title: err.message || "加载失败", icon: "none" });
        }
      });
  },

  // 上拉加载更多
  onReachBottom() {
    if (this.data.noMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.fetch());
  },

  decorate(j) {
    return Object.assign({}, j, {
      _discipline: fmt.disciplineCn(j.discipline),
      _if: fmt.ifText(j.impactFactor),
      _rate: fmt.rateText(j.acceptanceRate),
    });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/detail/detail?id=" + id });
  },
});
