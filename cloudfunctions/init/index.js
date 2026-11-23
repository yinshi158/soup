// ============================================================
// init 云函数：一键初始化（部署后运行一次即可，可重复运行）
//   1. 创建 4 个数据库集合：rooms / messages / chat_messages / stories
//   2. 写入内置题库（6 道经典海龟汤，含旧项目移植的 4 道）
// 注意：集合的"安全规则"需要按 README 第 5 步在控制台手动配置
// ============================================================

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const builtin = require('./builtin.json')

const COLLECTIONS = ['rooms', 'messages', 'chat_messages', 'stories', 'counters']

exports.main = async () => {
  const report = { collections: [], seeded: 0, skipped: 0 }

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name)
      report.collections.push(name + '（新建）')
    } catch (e) {
      report.collections.push(name + '（已存在）')
    }
  }

  for (const s of builtin) {
    const exist = await db.collection('stories')
      .where({ source: 'builtin', title: s.title })
      .count()
    if (exist.total > 0) {
      report.skipped++
      continue
    }
    await db.collection('stories').add({
      data: Object.assign({}, s, { source: 'builtin', createdAt: db.serverDate() })
    })
    report.seeded++
  }

  // 广场编号计数器（接续旧版 story_counter=65，首条广场故事为 #00065）
  try {
    await db.collection('counters').doc('plaza').get()
  } catch (e) {
    await db.collection('counters').doc('plaza').set({ data: { seq: 64 } })
  }

  return {
    success: true,
    report: report,
    reminder: '下一步：到云开发控制台 → 数据库 → 逐个集合设置安全规则（README 第 5 步）。stories 与 counters 必须设为所有用户不可读写，否则汤底会泄露！'
  }
}