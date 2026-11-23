const api = require('../../services/api')

Page({
  data: {
    nickname: '',
    joinCode: '',
    lastRoom: null,
    creating: false,
    joining: false
  },

  onLoad(options) {
    this.setData({ nickname: api.getNickname() })
    // 好友通过分享链接进来：自动填入房间码
    if (options && options.code) {
      this.setData({ joinCode: String(options.code).replace(/\D/g, '') })
      wx.showToast({ title: '已填入好友的房间码', icon: 'none' })
    }
  },

  onShow() {
    const last = api.getLastRoom()
    this.setData({ lastRoom: last && last.code ? last : null })
  },

  onNickname(e) {
    this.setData({ nickname: e.detail.value })
  },

  onCode(e) {
    this.setData({ joinCode: (e.detail.value || '').replace(/\D/g, '') })
  },

  validNickname() {
    const n = (this.data.nickname || '').trim()
    if (!n) {
      wx.showToast({ title: '请先填写昵称', icon: 'none' })
      return null
    }
    if (n.length > 12) {
      wx.showToast({ title: '昵称最多 12 个字', icon: 'none' })
      return null
    }
    return n
  },

  showError(err) {
    const msg = (err && err.message) || '操作失败'
    if (msg === api.ENV_TIP) {
      wx.showModal({ title: '还差一步配置', content: msg, showCancel: false })
    } else {
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  enterRoom(code, nickname) {
    api.setNickname(nickname)
    api.setLastRoom({ code: code, nickname: nickname })
    wx.navigateTo({
      url: '/pages/room/room?code=' + code + '&nickname=' + encodeURIComponent(nickname)
    })
  },

  // 创建房间：服务端随机准备一道内置题（房主进房后可换）
  createRoom() {
    const nickname = this.validNickname()
    if (!nickname || this.data.creating) return
    this.setData({ creating: true })
    const self = this
    api.room('create', { nickname: nickname })
      .then(function (res) { self.enterRoom(res.code, nickname) })
      .catch(function (err) { self.showError(err) })
      .then(function () { self.setData({ creating: false }) })
  },

  // 凭 6 位房间码加入
  joinRoom() {
    const nickname = this.validNickname()
    if (!nickname || this.data.joining) return
    const code = (this.data.joinCode || '').trim()
    if (!/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入 6 位数字房间码', icon: 'none' })
      return
    }
    this.setData({ joining: true })
    const self = this
    api.room('join', { code: code, nickname: nickname })
      .then(function () { self.enterRoom(code, nickname) })
      .catch(function (err) { self.showError(err) })
      .then(function () { self.setData({ joining: false }) })
  },

  // 继续上次的房间（同一微信号会自动认回原身份）
  resumeRoom() {
    const last = this.data.lastRoom
    if (!last) return
    const self = this
    api.room('join', { code: last.code, nickname: last.nickname })
      .then(function () { self.enterRoom(last.code, last.nickname) })
      .catch(function () {
        api.clearLastRoom()
        self.setData({ lastRoom: null })
        wx.showToast({ title: '上次的房间已关闭', icon: 'none' })
      })
  },

  goPlaza() {
    wx.navigateTo({ url: '/pages/plaza/plaza' })
  },

  onShareAppMessage() {
    return {
      title: '海龟汤仙人：AI 主持的多人联机推理游戏',
      path: '/pages/index/index'
    }
  }
})