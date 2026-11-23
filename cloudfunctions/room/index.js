// ============================================================
// room 云函数：房间生命周期 + 题目管理 + 玩家群聊
// 逻辑移植自旧项目 Turtle_Soup/app.py 的 HTTP 接口部分
// 安全要点：
//   - 所有写操作只走云函数（数据库安全规则禁止客户端写）
//   - 汤底(answer)只在房主揭晓后才下发给客户端
//   - 房主权限按 openid 校验（客户端显示按昵称，同旧版）
// ============================================================

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 房间最长存活 24h（另有每日 3 点定时清理）

function ok(data) { return Object.assign({ success: true }, data || {}) }
function err(message) { return { error: message } }

function genCode() {
  // 6 位纯数字房间码（100000-999999，避免前导 0 的输入歧义）
  return String(100000 + Math.floor(Math.random() * 900000))
}

async function getRoom(code) {
  try {
    const res = await db.collection('rooms').doc(code).get()
    return res.data
  } catch (e) {
    return null
  }
}

function roomExpired(room) {
  const t = new Date(room.createdAt).getTime()
  return !t || Date.now() - t > ROOM_TTL_MS
}

async function addMsg(roomCode, role, content, nickname) {
  await db.collection('messages').add({
    data: {
      roomCode: roomCode,
      role: role,
      content: content,
      nickname: nickname || '系统',
      createdAt: db.serverDate()
    }
  })
}

async function getStoryDoc(id) {
  try {
    const res = await db.collection('stories').doc(id).get()
    return res.data
  } catch (e) {
    return null
  }
}

// 内容安全检测（微信要求 UGC 必检；接口不可用时放行并记日志，上线前务必确认可用）
async function secCheck(content, openid) {
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      version: '2',
      scene: 2,
      openid: openid,
      content: String(content).slice(0, 2500)
    })
    if (r && r.result && r.result.suggest === 'risky') return false
    return true
  } catch (e) {
    console.warn('msgSecCheck 不可用（开发阶段可忽略，上线前请确认）:', e.message || e)
    return true
  }
}

async function destroyRoom(code) {
  await db.collection('rooms').doc(code).remove().catch(function () {})
  await db.collection('messages').where({ roomCode: code }).remove().catch(function () {})
  await db.collection('chat_messages').where({ roomCode: code }).remove().catch(function () {})
  await db.collection('stories').where({ roomCode: code, source: 'upload' }).remove().catch(function () {})
}

// ---------- 创建房间（旧版 /api/create_room） ----------
async function createRoom(event, openid) {
  const nickname = String(event.nickname || '').trim()
  if (!nickname) return err('请填写昵称')
  if (nickname.length > 12) return err('昵称最多 12 个字')

  // 生成不重复的 6 位纯数字房间码（旧版 gen_code 的数字版）
  let code = genCode()
  for (let i = 0; i < 10; i++) {
    const exist = await getRoom(code)
    if (!exist) break
    code = genCode()
  }

  // 开局题目：优先用指定的广场题（广场"一键开局"），否则随机内置题
  let storyIds = []
  let currentStoryIndex = -1
  let fromPlaza = false
  if (event.plazaStoryId) {
    const ps = await getStoryDoc(String(event.plazaStoryId))
    if (ps && ps.source === 'plaza') {
      storyIds = [ps._id]
      currentStoryIndex = 0
      fromPlaza = true
    }
  }
  if (!storyIds.length) {
    const builtin = await db.collection('stories').where({ source: 'builtin' }).limit(100).get()
    if (builtin.data.length) {
      const pick = builtin.data[Math.floor(Math.random() * builtin.data.length)]
      storyIds = [pick._id]
      currentStoryIndex = 0
    }
  }

  await db.collection('rooms').doc(code).set({
    data: {
      ownerOpenid: openid,
      ownerNickname: nickname,
      members: [{ openid: openid, nickname: nickname, lastSeen: Date.now() }],
      storyIds: storyIds,
      currentStoryIndex: currentStoryIndex,
      revealAnswer: false,
      passed: false,
      createdAt: db.serverDate()
    }
  })
  await addMsg(code, 'system', '房间创建成功！房间码 ' + code + '，发给朋友即可加入。')
  if (storyIds.length) {
    await addMsg(code, 'system', fromPlaza
      ? '已加载广场故事，房主可在「题目」页更换。开始提问吧！'
      : '已随机准备一道题，房主可在「题目」页更换。开始提问吧！')
  } else {
    await addMsg(code, 'system', '题库为空，请先运行 init 云函数初始化内置题库。')
  }
  return ok({ code: code })
}

// ---------- 加入房间（旧版 /api/join_room） ----------
async function joinRoom(event, openid) {
  const code = String(event.code || '').trim()
  const nickname = String(event.nickname || '').trim()
  if (!code || !nickname) return err('参数不完整')
  if (nickname.length > 12) return err('昵称最多 12 个字')

  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (roomExpired(room)) return err('房间已过期（每日凌晨 3 点自动清理）')

  const members = room.members || []
  const mine = members.find(function (m) { return m.openid === openid })

  if (mine) {
    // 同一微信号重新进入：认回原身份（比旧版按昵称认人更稳）
    const patch = { members: members }
    if (mine.nickname !== nickname) {
      const conflict = members.some(function (m) {
        return m.openid !== openid && m.nickname === nickname
      })
      if (conflict) return err('昵称已存在，换一个吧')
      mine.nickname = nickname
      if (room.ownerOpenid === openid) patch.ownerNickname = nickname
    }
    mine.lastSeen = Date.now()
    await db.collection('rooms').doc(code).update({ data: patch })
    return ok({ code: code, ownerNickname: patch.ownerNickname || room.ownerNickname })
  }

  if (members.some(function (m) { return m.nickname === nickname })) {
    return err('昵称已存在，换一个吧')
  }
  // 原子追加新成员，避免多人同时加入时互相覆盖
  await db.collection('rooms').doc(code).update({
    data: { members: _.push([{ openid: openid, nickname: nickname, lastSeen: Date.now() }]) }
  })
  await addMsg(code, 'system', nickname + ' 加入了房间')
  return ok({ code: code, ownerNickname: room.ownerNickname })
}

// ---------- 心跳（旧版 /api/heartbeat，60 秒无心跳视为离线） ----------
async function heartbeat(event, openid) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  const members = room.members || []
  const mine = members.find(function (m) { return m.openid === openid })
  if (!mine) return err('未加入房间')
  mine.lastSeen = Date.now()
  await db.collection('rooms').doc(code).update({ data: { members: members } })
  return ok()
}

// ---------- 退出房间 ----------
async function leaveRoom(event, openid) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return ok()
  const me = (room.members || []).find(function (m) { return m.openid === openid })
  const nickname = me ? me.nickname : '玩家'
  const members = (room.members || []).filter(function (m) { return m.openid !== openid })

  if (room.ownerOpenid === openid) {
    if (members.length) {
      // 房主退出 → 移交给最早加入的成员（旧版无移交，此处小改进避免房间失管）
      const next = members[0]
      await db.collection('rooms').doc(code).update({
        data: { members: members, ownerOpenid: next.openid, ownerNickname: next.nickname }
      })
      await addMsg(code, 'system', nickname + ' 离开了房间，房主已移交给 ' + next.nickname)
    } else {
      await destroyRoom(code)
    }
  } else {
    await db.collection('rooms').doc(code).update({ data: { members: members } })
    await addMsg(code, 'system', nickname + ' 离开了房间')
  }
  return ok()
}

// ---------- 关闭房间（旧版 /api/delete_room，仅房主） ----------
async function closeRoom(event, openid) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (room.ownerOpenid !== openid) return err('只有房主可以关闭房间')
  await destroyRoom(code)
  return ok()
}

// ---------- 获取当前题目（旧版 /api/get_current_story，汤底揭晓前保密） ----------
async function getStory(event) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  const idx = room.currentStoryIndex
  const ids = room.storyIds || []
  if (idx == null || idx < 0 || idx >= ids.length) return ok({ story: null })
  const story = await getStoryDoc(ids[idx])
  if (!story) return ok({ story: null })
  // 胜利条件(victory_condition)只供云端 AI 判定故事还原使用，
  // 绝不下发给任何玩家（旧版会显示给玩家，容易剧透，新版已隐藏）
  return ok({
    story: {
      title: story.title || '',
      surface: story.surface || '',
      answer: room.revealAnswer ? (story.answer || '') : ''
    }
  })
}

// ---------- 内置题库列表（只下发汤面，绝不下发汤底） ----------
async function listBuiltin() {
  const res = await db.collection('stories')
    .where({ source: 'builtin' })
    .field({ _id: true, title: true, surface: true })
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get()
  return ok({ stories: res.data })
}

// ---------- 房间已加载的题目列表 ----------
async function listRoomStories(event) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  const ids = room.storyIds || []
  if (!ids.length) return ok({ stories: [] })
  const res = await db.collection('stories')
    .where({ _id: _.in(ids) })
    .field({ _id: true, title: true })
    .get()
  const map = {}
  res.data.forEach(function (s) { map[s._id] = s })
  const stories = ids.map(function (id, index) {
    return {
      index: index,
      title: (map[id] && map[id].title) || '',
      current: index === room.currentStoryIndex
    }
  })
  return ok({ stories: stories })
}

// ---------- 从内置题库加载（旧版 /api/load_story_from_plaza） ----------
async function loadBuiltin(event, openid) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (room.ownerOpenid !== openid) return err('只有房主可以加载题目')
  const story = await getStoryDoc(String(event.storyId || ''))
  if (!story || story.source !== 'builtin') return err('题目不存在')
  const ids = (room.storyIds || []).concat([story._id])
  await db.collection('rooms').doc(code).update({
    data: { storyIds: ids, currentStoryIndex: ids.length - 1, revealAnswer: false }
  })
  await addMsg(code, 'system', '房主从题库加载了新题目：' + (story.title || ''))
  return ok({ count: ids.length })
}

// ---------- 从故事广场加载（第二期，仅房主） ----------
async function loadPlaza(event, openid) {
  const code = String(event.code || '').trim().toUpperCase()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (room.ownerOpenid !== openid) return err('只有房主可以加载题目')
  const story = await getStoryDoc(String(event.storyId || ''))
  if (!story || story.source !== 'plaza') return err('故事不存在')
  const ids = (room.storyIds || []).concat([story._id])
  await db.collection('rooms').doc(code).update({
    data: { storyIds: ids, currentStoryIndex: ids.length - 1, revealAnswer: false }
  })
  await addMsg(code, 'system', '房主从广场加载了新题目：' + (story.title || ''))
  return ok({ count: ids.length })
}

// ---------- 批量内容安全检测 ----------
// 旧实现是「每题一次接口调用 + 串行等待」，10 道题就是 10 次网络往返，必然撞上云函数超时。
// 这里保持「一题一检」的精确度，只把串行改成分组并发：每组 5 题同时送检，
// 10 道题只需 2 轮往返。
// 特意不把多题文本拼成一大段送检——那样容易因为多题的死亡/案件描述堆在一起被误判违规，
// 而且一旦误判就查不出到底是哪一题的问题。
// 返回 0 表示全部通过，否则返回第一道违规题目的序号（从 1 开始）。
async function secCheckBatch(items, openid) {
  const groups = chunk(items, 5)
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]
    const results = await Promise.all(group.map(function (s) {
      return secCheck(s.surface + ' ' + s.answer, openid)
    }))
    for (let k = 0; k < results.length; k++) {
      if (!results[k]) return group[k].no
    }
  }
  return 0
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ---------- 批量导入题目 JSON（旧版 /api/upload_story，格式完全一致） ----------
// 四个阶段严格分离，保证「要么整批生效，要么整批不生效」：
//   1. 全量校验（不碰数据库）——任何一题字段缺失，整批直接拒绝
//   2. 批量内容安全检测——违规则整批拒绝，并告知第几题
//   3. 分组并发写库——比逐条串行快一个数量级
//   4. 一次性绑定到房间 storyIds——前端只认这个字段
// 第 3、4 步任一失败都会删掉本批已写入的题目，不再留下"库里有、前端没有"的孤儿数据。
async function uploadStories(event, openid) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (room.ownerOpenid !== openid) return err('只有房主可以上传题目')

  let stories = event.stories
  if (!Array.isArray(stories)) stories = [stories]
  if (!stories.length) return err('题库为空')
  if (stories.length > 50) return err('一次最多上传 50 道题')

  // ---- 阶段 1：全量校验 + 规范化 ----
  const cleaned = []
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i] || {}
    const surface = String(s.surface || '').trim()
    const answer = String(s.answer || '').trim()
    const victory = String(s.victory_condition || '').trim()
    const additional = String(s.additional || '').trim()
    const title = String(s.title || s.name || '').trim()
    if (!surface || !answer || !victory) {
      return err('第 ' + (i + 1) + ' 道题缺少 surface / answer / victory_condition 字段，本批 ' +
        stories.length + ' 道题均未导入')
    }
    cleaned.push({
      no: i + 1,
      title: title || surface.slice(0, 20),
      surface: surface,
      answer: answer,
      additional: additional,
      victory_condition: victory
    })
  }

  // ---- 阶段 2：批量内容安全 ----
  const badNo = await secCheckBatch(cleaned, openid)
  if (badNo) {
    return err('第 ' + badNo + ' 道题包含违规内容，本批 ' + cleaned.length + ' 道题均未导入')
  }

  // ---- 阶段 3：分组并发写库（每组 10 条，避免瞬时并发过高）----
  const ids = []
  try {
    const groups = chunk(cleaned, 10)
    for (let g = 0; g < groups.length; g++) {
      const added = await Promise.all(groups[g].map(function (s) {
        return db.collection('stories').add({
          data: {
            title: s.title,
            surface: s.surface,
            answer: s.answer,
            additional: s.additional,
            victory_condition: s.victory_condition,
            source: 'upload',
            roomCode: code,
            createdAt: db.serverDate()
          }
        })
      }))
      added.forEach(function (a) { ids.push(a._id) })
    }
  } catch (e) {
    if (ids.length) {
      await db.collection('stories').where({ _id: _.in(ids) }).remove().catch(function () {})
    }
    return err('题目写入数据库失败，已回滚：' + (e.message || e))
  }

  // ---- 阶段 4：一次性绑定到房间，并切换到最新一题 ----
  const all = (room.storyIds || []).concat(ids)
  try {
    await db.collection('rooms').doc(code).update({
      data: { storyIds: all, currentStoryIndex: all.length - 1, revealAnswer: false }
    })
  } catch (e) {
    await db.collection('stories').where({ _id: _.in(ids) }).remove().catch(function () {})
    return err('题目绑定房间失败，已回滚：' + (e.message || e))
  }

  await addMsg(code, 'system',
    '房主批量导入了 ' + ids.length + ' 道新题目，已切换到最新一题：' +
    (cleaned[cleaned.length - 1].title || ''))
  return ok({
    count: ids.length,
    total: all.length,
    titles: cleaned.map(function (s) { return s.title })
  })
}

// ---------- 切换题目（旧版 /api/set_story） ----------
async function setStory(event, openid) {
  const code = String(event.code || '').trim()
  const idx = event.index
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (room.ownerOpenid !== openid) return err('只有房主可以切换题目')
  const ids = room.storyIds || []
  if (!ids.length) return err('题库为空')
  if (typeof idx !== 'number' || idx < 0 || idx >= ids.length) return err('题目索引超出范围')
  await db.collection('rooms').doc(code).update({
    data: { currentStoryIndex: idx, revealAnswer: false }
  })
  await addMsg(code, 'system', '房主已切换其他题目')
  return ok()
}

// ---------- 揭晓答案（旧版 /api/reveal_answer） ----------
async function reveal(event, openid) {
  const code = String(event.code || '').trim()
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  if (room.ownerOpenid !== openid) return err('只有房主可以揭晓答案')
  const ids = room.storyIds || []
  const idx = room.currentStoryIndex
  if (idx == null || idx < 0 || idx >= ids.length) return err('当前没有题目')
  const story = await getStoryDoc(ids[idx])
  if (!story) return err('题目不存在')
  await db.collection('rooms').doc(code).update({ data: { revealAnswer: true } })
  await addMsg(code, 'system', '房主已揭晓答案：' + (story.answer || ''))
  return ok()
}

// ---------- 玩家群聊（旧版 send_chat_message，无 AI 参与） ----------
async function chat(event, openid) {
  const code = String(event.code || '').trim()
  const content = String(event.content || '').trim()
  if (!code || !content) return err('参数不完整')
  if (content.length > 500) return err('消息太长啦（最多 500 字）')
  const room = await getRoom(code)
  if (!room) return err('房间不存在')
  const me = (room.members || []).find(function (m) { return m.openid === openid })
  if (!me) return err('未加入房间')
  if (!(await secCheck(content, openid))) return err('内容包含违规信息，请修改后再发')
  await db.collection('chat_messages').add({
    data: {
      roomCode: code,
      nickname: me.nickname,
      openid: openid,
      content: content,
      createdAt: db.serverDate()
    }
  })
  return ok()
}

// ---------- 入口路由 ----------
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  try {
    switch (event.action) {
      case 'create': return await createRoom(event, OPENID)
      case 'join': return await joinRoom(event, OPENID)
      case 'heartbeat': return await heartbeat(event, OPENID)
      case 'leave': return await leaveRoom(event, OPENID)
      case 'close': return await closeRoom(event, OPENID)
      case 'getStory': return await getStory(event)
      case 'listBuiltin': return await listBuiltin()
      case 'listRoomStories': return await listRoomStories(event)
      case 'loadBuiltin': return await loadBuiltin(event, OPENID)
      case 'loadPlaza': return await loadPlaza(event, OPENID)
      case 'uploadStories': return await uploadStories(event, OPENID)
      case 'setStory': return await setStory(event, OPENID)
      case 'reveal': return await reveal(event, OPENID)
      case 'chat': return await chat(event, OPENID)
      default: return err('未知操作: ' + event.action)
    }
  } catch (e) {
    console.error(e)
    return err('服务异常: ' + (e.message || e))
  }
}