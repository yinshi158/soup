const api = require('../../services/api')
const util = require('../../utils/util')

Page({
  data: {
    keyword: '',
    mode: 'all',
    list: [],
    page: 0,
    hasMore: true,
    loading: false,
    showDetail: false,
    detail: null
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ list: [], page: 0, hasMore: true })
    this.loadList(true)
  },

  loadList(reset) {
    if (this.data.loading) return
    this.setData({ loading: true })
    const self = this
    const page = reset ? 0 : this.data.page
    api.plaza('list', {
      keyword: this.data.keyword,
      page: page,
      mine: this.data.mode === 'mine'
    })
      .then(function (res) {
        const items = (res.stories || []).map(function (s) {
          return Object.assign({}, s, { time: util.formatTime(s.createdAt) })
        })
        self.setData({
          list: reset ? items : self.data.list.concat(items),
          page: page + 1,
          hasMore: !!res.hasMore,
          loading: false
        })
      })
      .catch(function (err) {
        self.setData({ loading: false })
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      })
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  doSearch() {
    this.refresh()
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
    this.refresh()
  },

  loadMore() {
    if (this.data.hasMore && !this.data.loading) this.loadList(false)
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    const self = this
    api.plaza('detail', { id: id })
      .then(function (res) {
        self.setData({ detail: res.story, showDetail: true })
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      })
  },

  closeDetail() {
    this.setData({ showDetail: false })
  },

  // 一键开局：用这道广场题创建房间
  startGame() {
    const d = this.data.detail
    if (!d) return
    const nickname = api.getNickname()
    if (!nickname) {
      wx.showModal({
        title: '先填昵称',
        content: '开局需要昵称，去首页填写一下吧',
        confirmText: '去首页',
        success: function (r) {
          if (r.confirm) wx.navigateTo({ url: '/pages/index/index' })
        }
      })
      return
    }
    api.room('create', { nickname: nickname, plazaStoryId: d._id })
      .then(function (res) {
        api.setLastRoom({ code: res.code, nickname: nickname })
        wx.navigateTo({
          url: '/pages/room/room?code=' + res.code + '&nickname=' + encodeURIComponent(nickname)
        })
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '开局失败', icon: 'none' })
      })
  },

  editStory() {
    const d = this.data.detail
    if (!d) return
    this.setData({ showDetail: false })
    wx.navigateTo({ url: '/pages/plaza-publish/plaza-publish?id=' + d._id })
  },

  removeStory() {
    const d = this.data.detail
    if (!d) return
    const self = this
    wx.showModal({
      title: '删除故事',
      content: '确定删除「' + d.title + '」吗？删除后不可恢复。',
      confirmColor: '#ef4444',
      success: function (r) {
        if (!r.confirm) return
        api.plaza('remove', { id: d._id })
          .then(function () {
            self.setData({ showDetail: false })
            wx.showToast({ title: '已删除', icon: 'success' })
            self.refresh()
          })
          .catch(function (err) {
            wx.showToast({ title: err.message || '删除失败', icon: 'none' })
          })
      }
    })
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/plaza-publish/plaza-publish' })
  },

  noop() {},

  onShareAppMessage() {
    return {
      title: '海龟汤故事广场：海量谜题，一键开局',
      path: '/pages/plaza/plaza'
    }
  }
})