// ============================================================
// 房间页 —— 核心玩法（逻辑移植自旧项目 Turtle_Soup）
//   AI 推理频道：是/不是/不重要、整理线索、故事还原、恭喜过关
//   玩家群聊：无 AI 参与，@成员高亮
//   题目面板：汤面/黄底答案（胜利条件仅云端 AI 可见，不下发玩家）；房主切题/上传/揭晓
//   成员列表：心跳在线状态（60 秒无心跳视为离线，同旧版）
// 实时性：数据库 watch 推送（消息/群聊/房间状态）+ 15 秒心跳
// ============================================================

const api = require('../../services/api')
const util = require('../../utils/util')

const HEARTBEAT_MS = 15000   // 心跳间隔
const ONLINE_MS = 60000      // 在线判定窗口（同旧版 60 秒）
const THINK_TIMEOUT = 90000  // "AI 思考中"兜底超时

Page({
  data: {
    code: '',
    nickname: '',
    isOwner: false,
    ownerNickname: '',
    members: [],
    onlineCount: 0,

    activeTab: 'ai',
    aiMessages: [],
    chatMessages: [],
    thinking: false,
    loading: true,

    story: null,
    hasStory: false,
    revealed: false,
    passed: false,
    passShown: false,
    showPass: false,
    roomStories: [],
    builtinStories: [],
    pickerTab: 'builtin',
    plazaStories: [],
    showStoryPicker: false,

    inputAI: '',
    inputChat: '',
    showRestore: false,
    restoreText: '',

    roomClosed: false,
    scrollAI: '',
    scrollChat: ''
  },

  onLoad(options) {
    const code = (options.code || '').trim()
    const nickname = options.nickname
      ? decodeURIComponent(options.nickname)
      : api.getNickname()
    if (!code || !nickname) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    if (!api.envReady()) {
      wx.showModal({
        title: '还差一步配置',
        content: api.ENV_TIP,
        showCancel: false,
        success: function () { wx.reLaunch({ url: '/pages/index/index' }) }
      })
      return
    }

    this.setData({ code: code, nickname: nickname })
    this._watchers = []
    this._storyIndex = undefined
    this._revealed = undefined
    this._lastAssistantId = ''
    this._closed = false
    this._watchErrShown = false

    this.startWatchers()
    this.fetchStory()
    this.heartbeat()
    const self = this
    this._hbTimer = setInterval(function () { self.heartbeat() }, HEARTBEAT_MS)
  },

  onUnload() {
    this.cleanup()
  },

  cleanup() {
    (this._watchers || []).forEach(function (w) {
      try { w.close() } catch (e) {}
    })
    this._watchers = []
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null }
    if (this._thinkTimer) { clearTimeout(this._thinkTimer); this._thinkTimer = null }
  },

  noop() {},

  // ---------- 实时同步 ----------
  startWatchers() {
    const db = api.db()
    const code = this.data.code
    const self = this

    const onWatchError = function (err) {
      console.error('watch error', err)
      self.setData({ loading: false })
      if (self._watchErrShown) return
      self._watchErrShown = true
      wx.showModal({
        title: '实时同步失败',
        content: '请确认已按 README 第 5 步配置集合安全规则（rooms / messages / chat_messages 需设为所有用户可读）。',
        showCancel: false
      })
    }

    // 房间状态：成员、当前题目、揭晓标志、过关标志
    this._watchers.push(
      db.collection('rooms').where({ _id: code }).watch({
        onChange: function (snap) {
          const doc = snap.docs && snap.docs[0]
          if (!doc) { self.onRoomClosed(); return }
          self.applyRoom(doc)
        },
        onError: onWatchError
      })
    )

    // AI 推理频道消息
    this._watchers.push(
      db.collection('messages').where({ roomCode: code }).watch({
        onChange: function (snap) {
          const docs = (snap.docs || []).slice().sort(util.docSort)
          const msgs = docs.map(function (d) { return self.decorateMsg(d) })
          // 收到新的 AI 回复 → 结束"思考中"动画
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') {
              if (msgs[i].id !== self._lastAssistantId) {
                self._lastAssistantId = msgs[i].id
                self.setData({ thinking: false })
              }
              break
            }
          }
          self.setData({
            aiMessages: msgs,
            loading: false,
            scrollAI: 'msg-' + (msgs.length - 1)
          })
        },
        onError: onWatchError
      })
    )

    // 玩家群聊（只保留最近 100 条，同旧版）
    this._watchers.push(
      db.collection('chat_messages').where({ roomCode: code }).watch({
        onChange: function (snap) {
          const docs = (snap.docs || []).slice().sort(util.docSort).slice(-100)
          const names = self.data.members.map(function (m) { return m.nickname })
          const msgs = docs.map(function (d) {
            return {
              id: d._id,
              nickname: d.nickname,
              self: d.nickname === self.data.nickname,
              time: util.formatTime(d.createdAt),
              segments: util.mentionSegments(d.content, names)
            }
          })
          self.setData({
            chatMessages: msgs,
            scrollChat: 'chat-' + (msgs.length - 1)
          })
        },
        onError: onWatchError
      })
    )
  },

  // 房间文档 → 页面状态
  applyRoom(doc) {
    const now = Date.now()
    const members = (doc.members || []).map(function (m) {
      return {
        nickname: m.nickname,
        online: now - (m.lastSeen || 0) < ONLINE_MS,
        isOwner: m.nickname === doc.ownerNickname
      }
    })
    const revealed = !!doc.revealAnswer
    const passed = !!doc.passed
    const storyChanged =
      doc.currentStoryIndex !== this._storyIndex || revealed !== this._revealed
    this._storyIndex = doc.currentStoryIndex
    this._revealed = revealed

    const patch = {
      ownerNickname: doc.ownerNickname || '',
      isOwner: doc.ownerNickname === this.data.nickname,
      members: members,
      onlineCount: members.filter(function (m) { return m.online }).length,
      revealed: revealed,
      passed: passed
    }
    // 恭喜过关弹窗（每局只弹一次，同旧版 pass 事件）
    if (passed && !this.data.passShown) {
      patch.showPass = true
      patch.passShown = true
    }
    this.setData(patch)

    if (storyChanged) {
      this.fetchStory()
      if (patch.isOwner) this.fetchRoomStories()
    }
  },

  decorateMsg(d) {
    const role = d.role || 'user'
    const content = d.content || ''
    const verdict =
      role === 'assistant' &&
      ['是', '不是', '不重要', '不确定'].indexOf(content.trim()) > -1
    return {
      id: d._id,
      role: role,
      nickname: d.nickname || (role === 'assistant' ? 'AI' : ''),
      content: content,
      verdict: verdict,
      self: role === 'user' && d.nickname === this.data.nickname,
      time: util.formatTime(d.createdAt)
    }
  },

  // ---------- 数据拉取 ----------
  fetchStory() {
    const self = this
    api.room('getStory', { code: this.data.code })
      .then(function (res) {
        self.setData({ story: res.story || null, hasStory: !!res.story })
      })
      .catch(function () {
        self.setData({ story: null, hasStory: false })
      })
  },

  fetchRoomStories() {
    const self = this
    api.room('listRoomStories', { code: this.data.code })
      .then(function (res) { self.setData({ roomStories: res.stories || [] }) })
      .catch(function () {})
  },

  heartbeat() {
    api.room('heartbeat', { code: this.data.code }).catch(function () {})
  },

  // ---------- AI 推理 ----------
  onInputAI(e) {
    this.setData({ inputAI: e.detail.value })
  },

  sendContent(content) {
    if (!this.data.hasStory) {
      wx.showToast({ title: '房主还没有选题，先去「题目」页看看', icon: 'none' })
      return
    }
    this.setData({ thinking: true })
    this.armThinkTimer()
    api.ai('ask', { code: this.data.code, content: content })
      .catch(function (err) {
        // 即使调用超时，AI 回复也会通过实时推送送达
        wx.showToast({ title: (err && err.message) || '发送失败', icon: 'none' })
      })
  },

  sendAI() {
    const content = (this.data.inputAI || '').trim()
    if (!content) return
    this.setData({ inputAI: '' })
    this.sendContent(content)
  },

  // 整理线索：作为普通提问发送，由提示词规则处理（同旧版）
  quickClue() {
    this.sendContent('整理线索')
  },

  armThinkTimer() {
    const self = this
    if (this._thinkTimer) clearTimeout(this._thinkTimer)
    this._thinkTimer = setTimeout(function () {
      self.setData({ thinking: false })
    }, THINK_TIMEOUT)
  },

  // ---------- 故事还原 ----------
  openRestore() {
    if (!this.data.hasStory) {
      wx.showToast({ title: '当前房间没有题目', icon: 'none' })
      return
    }
    this.setData({ showRestore: true })
  },

  closeRestore() {
    this.setData({ showRestore: false })
  },

  onRestoreInput(e) {
    this.setData({ restoreText: e.detail.value })
  },

  submitRestore() {
    const content = (this.data.restoreText || '').trim()
    if (!content) {
      wx.showToast({ title: '先写下你的推理', icon: 'none' })
      return
    }
    this.setData({ showRestore: false, restoreText: '', thinking: true })
    this.armThinkTimer()
    api.ai('restore', { code: this.data.code, content: content })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
      })
  },

  closePass() {
    this.setData({ showPass: false })
  },

  // ---------- 玩家群聊 ----------
  onInputChat(e) {
    this.setData({ inputChat: e.detail.value })
  },

  sendChat() {
    const content = (this.data.inputChat || '').trim()
    if (!content) return
    this.setData({ inputChat: '' })
    api.room('chat', { code: this.data.code, content: content })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || '发送失败', icon: 'none' })
      })
  },

  // ---------- Tab / 分享 ----------
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
    if (tab === 'story' && this.data.isOwner) this.fetchRoomStories()
  },

  copyCode() {
    wx.setClipboardData({
      data: this.data.code,
      success: function () { wx.showToast({ title: '房间码已复制', icon: 'success' }) }
    })
  },

  onShareAppMessage() {
    return {
      title: this.data.nickname + ' 邀请你加入海龟汤仙人推理房间，房间码 ' + this.data.code,
      path: '/pages/index/index?code=' + this.data.code
    }
  },

  // ---------- 房主：题目管理 ----------
  switchStory(e) {
    const index = e.currentTarget.dataset.index
    if (index === this._storyIndex) return
    const self = this
    wx.showModal({
      title: '切换题目',
      content: '确定切换到这道题吗？聊天记录会保留。',
      success: function (r) {
        if (!r.confirm) return
        api.room('setStory', { code: self.data.code, index: index })
          .catch(function (err) {
            wx.showToast({ title: err.message || '切换失败', icon: 'none' })
          })
      }
    })
  },

  openStoryPicker() {
    const self = this
    this.setData({ pickerTab: 'builtin' })
    api.room('listBuiltin', {})
      .then(function (res) {
        self.setData({ builtinStories: res.stories || [], showStoryPicker: true })
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '题库加载失败', icon: 'none' })
      })
  },

  switchPickerTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ pickerTab: tab })
    if (tab === 'plaza' && !this.data.plazaStories.length) {
      const self = this
      api.plaza('list', { page: 0 })
        .then(function (res) { self.setData({ plazaStories: res.stories || [] }) })
        .catch(function (err) {
          wx.showToast({ title: err.message || '广场加载失败', icon: 'none' })
        })
    }
  },

  loadPlazaStory(e) {
    const id = e.currentTarget.dataset.id
    const self = this
    api.room('loadPlaza', { code: this.data.code, storyId: id })
      .then(function () {
        self.setData({ showStoryPicker: false })
        wx.showToast({ title: '已加载广场题目', icon: 'success' })
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      })
  },

  closeStoryPicker() {
    this.setData({ showStoryPicker: false })
  },

  loadBuiltin(e) {
    const id = e.currentTarget.dataset.id
    const self = this
    api.room('loadBuiltin', { code: this.data.code, storyId: id })
      .then(function () {
        self.setData({ showStoryPicker: false })
        wx.showToast({ title: '已加载新题目', icon: 'success' })
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      })
  },

  // 从聊天会话里选 JSON 文件批量导入（格式与旧版完全一致，支持单题/数组，一次最多 50 道）
  uploadJSON() {
    const self = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        if (file.size > 20 * 1024 * 1024) {
          wx.showToast({ title: '文件不能超过 20MB', icon: 'none' })
          return
        }
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'utf8',
          success: function (r) {
            let data
            try {
              data = JSON.parse(r.data)
            } catch (e) {
              wx.showModal({
                title: 'JSON 解析失败',
                content: '文件不是合法的 JSON。常见原因：用了单引号、最后一项后面多了逗号、文件不是 UTF-8 编码。',
                showCancel: false
              })
              return
            }
            if (!Array.isArray(data)) data = [data]
            if (!data.length) {
              wx.showToast({ title: '文件里没有题目', icon: 'none' })
              return
            }
            if (data.length > 50) {
              wx.showToast({ title: '一次最多导入 50 道题', icon: 'none' })
              return
            }
            wx.showLoading({ title: '导入 ' + data.length + ' 道题…', mask: true })
            api.room('uploadStories', { code: self.data.code, stories: data })
              .then(function (out) {
                wx.hideLoading()
                // 主动刷新，不只依赖实时推送
                self.fetchStory()
                self.fetchRoomStories()
                wx.showToast({
                  title: '已导入 ' + out.count + ' 道题',
                  icon: 'success',
                  duration: 2000
                })
              })
              .catch(function (err) {
                wx.hideLoading()
                // 失败也刷新一次，避免界面和云端状态不一致
                self.fetchStory()
                self.fetchRoomStories()
                wx.showModal({
                  title: '导入失败',
                  content: (err && err.message) || '未知错误',
                  showCancel: false
                })
              })
          },
          fail: function () {
            wx.showToast({ title: '文件读取失败', icon: 'none' })
          }
        })
      }
    })
  },

  reveal() {
    const self = this
    wx.showModal({
      title: '揭晓答案',
      content: '确定向所有玩家公布汤底吗？',
      success: function (r) {
        if (!r.confirm) return
        api.room('reveal', { code: self.data.code })
          .catch(function (err) {
            wx.showToast({ title: err.message || '操作失败', icon: 'none' })
          })
      }
    })
  },

  closeRoom() {
    const self = this
    wx.showModal({
      title: '关闭房间',
      content: '关闭后所有成员都会被移出，聊天记录将被删除。确定关闭？',
      confirmColor: '#ef4444',
      success: function (r) {
        if (!r.confirm) return
        api.room('close', { code: self.data.code })
          .catch(function (err) {
            wx.showToast({ title: err.message || '操作失败', icon: 'none' })
          })
      }
    })
  },

  leaveRoom() {
    const self = this
    wx.showModal({
      title: '退出房间',
      content: '确定退出当前房间吗？',
      success: function (r) {
        if (!r.confirm) return
        api.room('leave', { code: self.data.code })
          .catch(function () {})
          .then(function () {
            api.clearLastRoom()
            wx.reLaunch({ url: '/pages/index/index' })
          })
      }
    })
  },

  // 房间被关闭 / 到期清理（watch 发现房间文档消失）
  onRoomClosed() {
    if (this._closed) return
    this._closed = true
    this.cleanup()
    api.clearLastRoom()
    this.setData({ roomClosed: true })
    wx.showModal({
      title: '房间已关闭',
      content: '房主关闭了房间，或房间已到期清理。',
      showCancel: false,
      success: function () { wx.reLaunch({ url: '/pages/index/index' }) }
    })
  }
})