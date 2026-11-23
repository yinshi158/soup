// ============================================================
// cleanup 云函数：每日凌晨 3 点清空所有房间
// （移植自旧版 daily_cleanup_task：房间存内存、每天 3 点全清）
// 定时触发器见同目录 config.json，部署后自动生效。
// 顺带清理玩家上传的题目，保留内置题库。
// ============================================================

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async () => {
  const stats = {}

  for (const name of ['rooms', 'messages', 'chat_messages']) {
    try {
      const r = await db.collection(name).where({ _id: _.exists(true) }).remove()
      stats[name] = (r.stats && r.stats.removed) != null ? r.stats.removed : 'ok'
    } catch (e) {
      stats[name] = e.message
    }
  }

  try {
    const r = await db.collection('stories').where({ source: 'upload' }).remove()
    stats.uploadStories = (r.stats && r.stats.removed) != null ? r.stats.removed : 'ok'
  } catch (e) {
    stats.uploadStories = e.message
  }

  console.log('[定时清理] 完成', stats)
  return { success: true, stats: stats }
}