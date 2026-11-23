// ============================================================
// ai 云函数：AI 主持人（DeepSeek，OpenAI 兼容接口）
// 提示词与判定规则原样移植自旧项目 Turtle_Soup/app.py：
//   - 只回答 是 / 不是 / 不重要
//   - "整理线索" 汇总已回答内容
//   - 故事还原三档判定：正确 / 大致正确 / 错误
//   - 上下文保留最近 40 条（20 轮）
//   - 回复包含"故事还原正确/大致正确" → 房间标记过关
// ============================================================

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const https = require('https')
const cfg = require('./ai-config')

// ===== 规则提示词：逐字移植旧版 CUSTOM_STORY_RESTORE_GUIDE =====
const CUSTOM_STORY_RESTORE_GUIDE =
  '【重要规则补充】\n' +
  "1. 你是海龟汤推理游戏的主持人，你知道完整的汤底（答案），但绝对不能主动透露汤底的任何内容。玩家提问时你只能回答'是'、'不是'或'不重要'，不得给提示或解释。\n" +
  "2. 当玩家输入'整理线索'时，整理之前所有AI回答中有用的线索和不重要的线索：只总结AI已明确回答过的内容，绝对不要展开联想或推测汤底。'是'或'不是'的问题如无法确定可输出'不确定'。\n" +
  "3. 当玩家输入的内容以'【故事还原】'开头时，表示玩家正在进行故事还原。你需要根据汤底和胜利条件进行判断。判断标准：不需要完全一字不差，只要玩家还原的故事涵盖了胜利条件中要求的核心要点和大致意思即可。\n" +
  "   - 如果玩家的还原完全偏离事实或遗漏核心要点 → 回复'故事还原错误'\n" +
  "   - 如果玩家的还原涵盖了核心要点和大致意思 → 回复'故事还原正确'\n" +
  "   - 如果玩家的还原覆盖了大部分核心要点但有少量偏差或遗漏 → 回复'故事还原大致正确'\n" +
  '   - 回复内容只能是这三个标签之一，不能有其他内容、提示、解释或标点。\n' +
  "4. 其余时间严格按照海龟汤规则进行推理问答：玩家提问 → AI只能回复'是'/'不是'/'不重要'。\n"

// ===== 系统提示词：移植旧版默认 preset（汤面+汤底+补充+胜利条件） =====
function buildPreset(story) {
  if (!story) {
    return '当前房间还没有题目，请房主在「题目」页从内置题库选题或上传题目。'
  }
  return (
    '你现在是海龟汤推理游戏的主持人。以下是完整汤底（答案），你需要根据汤底回答玩家的问题，但绝对不能主动透露汤底。\n\n' +
    '汤面（玩家看到的谜题）：' + (story.surface || '') + '\n\n' +
    '汤底（完整真相，仅供你参考，绝对保密）：' + (story.answer || '') + '\n\n' +
    '补充说明（仅供AI参考）：' + (story.additional || '') + '\n\n' +
    '胜利条件：' + (story.victory_condition || '') + '\n\n' +
    CUSTOM_STORY_RESTORE_GUIDE
  )
}

// ===== 调用 DeepSeek（OpenAI 兼容 /chat/completions，零第三方依赖） =====
function callDeepSeek(messages) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ model: cfg.model, messages: messages })
    const base = cfg.baseUrl.replace(/\/+$/, '')
    const url = new URL(base + '/chat/completions')
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 55000
      },
      function (res) {
        let data = ''
        res.on('data', function (c) { data += c })
        res.on('end', function () {
          try {
            const json = JSON.parse(data)
            if (res.statusCode !== 200) {
              reject(new Error('API ' + res.statusCode + ': ' + ((json.error && json.error.message) || data.slice(0, 200))))
              return
            }
            const reply =
              json.choices && json.choices[0] &&
              json.choices[0].message && json.choices[0].message.content
            resolve(reply || '[AI错误]返回内容为空')
          } catch (e) {
            reject(new Error('API 返回解析失败: ' + data.slice(0, 200)))
          }
        })
      }
    )
    req.on('timeout', function () { req.destroy(new Error('AI 接口超时')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function getRoom(code) {
  try {
    const res = await db.collection('rooms').doc(code).get()
    return res.data
  } catch (e) {
    return null
  }
}

async function currentStory(room) {
  const ids = room.storyIds || []
  const idx = room.currentStoryIndex
  if (idx == null || idx < 0 || idx >= ids.length) return null
  try {
    const res = await db.collection('stories').doc(ids[idx]).get()
    return res.data
  } catch (e) {
    return null
  }
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

function isPassReply(reply) {
  return reply.indexOf('故事还原正确') > -1 || reply.indexOf('故事还原大致正确') > -1
}

async function markPassed(code) {
  await db.collection('rooms').doc(code).update({ data: { passed: true } }).catch(function () {})
}

// ---------- 推理问答（旧版 send_ai_message） ----------
async function ask(event, openid) {
  const code = String(event.code || '').trim()
  const content = String(event.content || '').trim()
  if (!code || !content) return { error: '参数不完整' }
  if (content.length > 500) return { error: '问题太长啦（最多 500 字）' }

  const room = await getRoom(code)
  if (!room) return { error: '房间不存在' }
  const me = (room.members || []).find(function (m) { return m.openid === openid })
  if (!me) return { error: '未加入房间' }
  const nickname = me.nickname

  if (!(await secCheck(content, openid))) {
    return { error: '内容包含违规信息，请修改后再发' }
  }

  const story = await currentStory(room)

  // 先写入玩家消息 → 全员实时可见（同旧版"先广播、再等 AI"）
  await addMsg(code, 'user', content, nickname)

  // 上下文：最近 40 条 user/assistant（即 20 轮，同旧版 ai_context）
  const ctxRes = await db.collection('messages')
    .where({ roomCode: code, role: _.in(['user', 'assistant']) })
    .orderBy('createdAt', 'desc')
    .limit(40)
    .get()
  const context = ctxRes.data.reverse().map(function (m) {
    return {
      role: m.role,
      content: m.role === 'user' ? (m.nickname + ': ' + m.content) : m.content
    }
  })
  const messages = [{ role: 'system', content: buildPreset(story) }].concat(context)

  let reply
  try {
    reply = await callDeepSeek(messages)
  } catch (e) {
    reply = '[AI错误]' + (e.message || e)
  }

  await addMsg(code, 'assistant', reply, 'AI')
  if (isPassReply(reply)) await markPassed(code)
  return { success: true, reply: reply }
}

// ---------- 故事还原（旧版 restore_story，判定提示词逐字移植） ----------
async function restore(event, openid) {
  const code = String(event.code || '').trim()
  const content = String(event.content || '').trim()
  if (!code || !content) return { error: '参数不完整' }
  if (content.length > 1000) return { error: '还原内容太长啦（最多 1000 字）' }

  const room = await getRoom(code)
  if (!room) return { error: '房间不存在' }
  const me = (room.members || []).find(function (m) { return m.openid === openid })
  if (!me) return { error: '未加入房间' }
  const nickname = me.nickname

  const story = await currentStory(room)
  if (!story) return { error: '当前房间没有题目' }

  if (!(await secCheck(content, openid))) {
    return { error: '内容包含违规信息，请修改后再发' }
  }

  // 其他玩家只看到"提交了还原"，看不到具体内容（同旧版防剧透）
  await addMsg(code, 'system', '【故事还原】' + nickname + ' 提交了故事还原')

  const restorePrompt =
    '玩家正在进行故事还原。以下是完整汤底：\n\n' + (story.answer || '') +
    '\n\n胜利条件：' + (story.victory_condition || '') +
    '\n\n玩家还原的内容为：\n' + content +
    "\n\n请根据汤底和胜利条件进行判断。判断标准：不需要完全一字不差，只要玩家还原的故事涵盖了胜利条件中要求的核心要点和大致意思即可。如果完全偏离或遗漏核心要点回复'故事还原错误'，如果涵盖核心要点和大致意思回复'故事还原正确'，如果覆盖大部分但有少量偏差回复'故事还原大致正确'。只回复这三个标签之一，不能有其他内容。"

  let reply
  try {
    reply = await callDeepSeek([{ role: 'user', content: restorePrompt }])
  } catch (e) {
    reply = '[AI错误]' + (e.message || e)
  }

  await addMsg(code, 'assistant', reply, 'AI')
  if (isPassReply(reply)) await markPassed(code)
  return { success: true, reply: reply }
}

// ---------- 入口路由 ----------
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  try {
    switch (event.action) {
      case 'ask': return await ask(event, OPENID)
      case 'restore': return await restore(event, OPENID)
      default: return { error: '未知操作: ' + event.action }
    }
  } catch (e) {
    console.error(e)
    return { error: '服务异常: ' + (e.message || e) }
  }
}