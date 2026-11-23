const config = require('./config')

App({
  globalData: {
    // 云开发环境是否已初始化（config.js 里填了正确的 envId 才会为 true）
    envReady: false
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请把调试基础库升级到 2.2.3 以上')
      return
    }
    if (config.envId && config.envId !== 'your-env-id') {
      wx.cloud.init({
        env: config.envId,
        traceUser: true
      })
      this.globalData.envReady = true
    } else {
      console.warn('尚未配置云开发环境 ID，请修改 miniprogram/config.js（见 README 第 3 步）')
    }
  }
})