const api = require('../../services/api')

Page({
  data: {
    id: '',
    isEdit: false,
    plazaNo: '',
    title: '',
    surface: '',
    answer: '',
    victory: '',
    additional: '',
    submitting: false
  },

  onLoad(options) {
    if (options && options.id) {
      this.setData({ id: options.id, isEdit: true })
      const self = this
      api.plaza('getForEdit', { id: options.id })
        .then(function (res) {
          const s = res.story
          self.setData({
            title: s.title,
            surface: s.surface,
            answer: s.answer,
            victory: s.victory_condition,
            additional: s.additional,
            plazaNo: s.plazaNo
          })
        })
        .catch(function (err) {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' })
          setTimeout(function () { wx.navigateBack() }, 1200)
        })
    }
  },

  onTitle(e) { this.setData({ title: e.detail.value }) },
  onSurface(e) { this.setData({ surface: e.detail.value }) },
  onAnswer(e) { this.setData({ answer: e.detail.value }) },
  onVictory(e) { this.setData({ victory: e.detail.value }) },
  onAdditional(e) { this.setData({ additional: e.detail.value }) },

  // 从聊天会话选 JSON：单题填表单；多题确认后直接批量发布到广场
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
            const list = Array.isArray(data) ? data : [data]
            const valid = list.filter(function (x) { return x && typeof x === 'object' })
            if (!valid.length) {
              wx.showToast({ title: '文件里没有题目', icon: 'none' })
              return
            }
            // 编辑模式只能修改当前这一道
            if (self.data.isEdit) {
              self.fillForm(valid[0])
              wx.showToast({ title: '编辑模式只取第一道填入表单', icon: 'none' })
              return
            }
            if (valid.length === 1) {
              self.fillForm(valid[0])
              wx.showToast({ title: '已填入表单，请检查后发布', icon: 'none' })
              return
            }
            if (valid.length > 20) {
              wx.showToast({ title: '一次最多发布 20 道', icon: 'none' })
              return
            }
            wx.showModal({
              title: '批量发布',
              content: '检测到 ' + valid.length + ' 道故事，确认全部发布到故事广场？',
              confirmText: '全部发布',
              success: function (m) {
                if (m.confirm) self.batchPublish(valid)
              }
            })
          },
          fail: function () { wx.showToast({ title: '文件读取失败', icon: 'none' }) }
        })
      }
    })
  },

  fillForm(d) {
    this.setData({
      title: d.title || d.name || this.data.title,
      surface: d.surface || '',
      answer: d.answer || '',
      victory: d.victory_condition || '',
      additional: d.additional || ''
    })
  },

  // 批量发布：交给 plaza 云函数的 publish（它支持 stories 数组）
  batchPublish(stories) {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    const self = this
    wx.showLoading({ title: '发布 ' + stories.length + ' 道…', mask: true })
    api.plaza('publish', { nickname: api.getNickname(), stories: stories })
      .then(function (res) {
        wx.hideLoading()
        wx.showToast({
          title: '已发布 ' + (res.count || stories.length) + ' 道',
          icon: 'success',
          duration: 2000
        })
        setTimeout(function () { wx.navigateBack() }, 1600)
      })
      .catch(function (err) {
        wx.hideLoading()
        self.setData({ submitting: false })
        wx.showModal({
          title: '批量发布失败',
          content: (err && err.message) || '未知错误',
          showCancel: false
        })
      })
  },

  submit() {
    const title = (this.data.title || '').trim()
    const surface = (this.data.surface || '').trim()
    const answer = (this.data.answer || '').trim()
    const victory = (this.data.victory || '').trim()
    const additional = (this.data.additional || '').trim()
    if (!title) { wx.showToast({ title: '请填写故事名称', icon: 'none' }); return }
    if (!surface || !answer || !victory) {
      wx.showToast({ title: '汤面 / 汤底 / 胜利条件必填', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    this.setData({ submitting: true })
    const self = this
    const payload = {
      title: title, surface: surface, answer: answer,
      victory_condition: victory, additional: additional
    }
    const req = this.data.isEdit
      ? api.plaza('edit', Object.assign({ id: this.data.id }, payload))
      : api.plaza('publish', Object.assign({ nickname: api.getNickname() }, payload))

    req.then(function (res) {
      wx.showToast({
        title: self.data.isEdit ? '已保存' : ('发布成功 ' + (res.stories && res.stories[0] ? res.stories[0].plazaNo : '')),
        icon: 'success'
      })
      setTimeout(function () { wx.navigateBack() }, 900)
    })
      .catch(function (err) {
        self.setData({ submitting: false })
        wx.showToast({ title: err.message || '提交失败', icon: 'none' })
      })
  }
})