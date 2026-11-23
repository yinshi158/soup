// ============================================================
// 后端调用统一入口（数据层）
// 所有与云开发的交互都收口在这里：
//   - room(action, data)  房间/题目/群聊相关云函数
//   - ai(action, data)    AI 主持相关云函数
//   - db()                数据库实例（用于实时 watch）
// 以后如果要换成自有服务器后端，只需要改这一个文件。
// ============================================================

function envReady() {
  const app = getApp()
  return !!(app && app.globalData && app.globalData.envReady)
}

const ENV_TIP = '还没配置云开发环境：请打开 miniprogram/config.js，把 envId 换成你的云开发环境 ID（README 第 3 步有详细说明）'

function call(name, data) {
  return new Promise(function (resolve, reject) {
    if (!envReady()) {
      reject(new Error(ENV_TIP))
      return
    }
    wx.cloud.callFunction({
      name: name,
      data: data,
      success: function (res) {
        const r = (res && res.result) || {}
        if (r.error) {
          reject(new Error(r.error))
        } else {
          resolve(r)
        }
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '网络请求失败，请检查云函数是否已部署'))
      }
    })
  })
}

function room(action, data) {
  return call('room', Object.assign({ action: action }, data || {}))
}

function ai(action, data) {
  return call('ai', Object.assign({ action: action }, data || {}))
}

function plaza(action, data) {
  return call('plaza', Object.assign({ action: action }, data || {}))
}

function db() {
  return wx.cloud.database()
}

// ---------- 本地缓存 ----------
const KEY_NICK = 'soup_nickname'
const KEY_LAST = 'soup_last_room'

function getNickname() {
  try { return wx.getStorageSync(KEY_NICK) || '' } catch (e) { return '' }
}
function setNickname(n) {
  try { wx.setStorageSync(KEY_NICK, n) } catch (e) {}
}
function getLastRoom() {
  try { return wx.getStorageSync(KEY_LAST) || null } catch (e) { return null }
}
function setLastRoom(r) {
  try { wx.setStorageSync(KEY_LAST, r) } catch (e) {}
}
function clearLastRoom() {
  try { wx.removeStorageSync(KEY_LAST) } catch (e) {}
}

module.exports = {
  room: room,
  ai: ai,
  plaza: plaza,
  db: db,
  envReady: envReady,
  ENV_TIP: ENV_TIP,
  getNickname: getNickname,
  setNickname: setNickname,
  getLastRoom: getLastRoom,
  setLastRoom: setLastRoom,
  clearLastRoom: clearLastRoom
}