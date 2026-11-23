// ============================================================
// plaza 云函数：故事广场（第二期）
// 逻辑移植自旧项目 Turtle_Soup 的故事广场：
//   浏览/搜索、在线填表或 JSON 发布、编号自增、编辑/删除、一键开局
// 本期决策：
//   - 仅发布者本人（openid）可编辑/删除（替代旧版"编号+密码"）
//   - 内容安全检测通过后直接发布（同旧版实际行为）
// 安全要点：
//   - 列表/详情只下发汤面，绝不下发汤底/胜利条件
//   - 汤底仅在发布者本人"取编辑内容"时返回
// ============================================================

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PAGE_SIZE = 20

function ok(data) { return Object.assign({ success: true }, data || {}) }
function err(message) { return { error: message } }

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

async function getStory(id) {
  try {
    const res = await db.collection('stories').doc(id).get()
    return res.data
  } catch (e) {
    return null
  }
}

// 编号批量预取（一次事务占下 N 个号）
// 旧做法是每道题开一次事务取一个号，10 道题就是 10 次事务往返，3 秒超时根本不够；
// 这里一次事务把这一批的号全占下来，后面写库就能并发。
async function reserveNos(count) {
  let start = 65
  try {
    await db.runTransaction(async function (t) {
      let cur = 64
      try {
        const r = await t.collection('counters').doc('plaza').get()
        cur = (r.data && r.data.seq) || 64
      } catch (e) {
        cur = 64
      }
      start = cur + 1
      await t.collection('counters').doc('plaza').set({ data: { seq: cur + count } })
    })
  } catch (e) {
    const c = await db.collection('stories').where({ source: 'plaza' }).count()
    start = 65 + c.total
  }
  const nos = []
  for (let i = 0; i < count; i++) {
    nos.push('#' + String(start + i).padStart(5, '0'))
  }
  return nos
}

// ---------- 列表 / 搜索（只下发汤面） ----------
async function list(event, openid) {
  const keyword = String(event.keyword || '').trim()
  const page = Math.max(0, parseInt(event.page, 10) || 0)
  const mine = !!event.mine

  let cond = { source: 'plaza' }
  if (mine) cond.publisherOpenid = openid
  if (keyword) {
    const reg = db.RegExp({ regexp: keyword, options: 'i' })
    const base = { source: 'plaza' }
    if (mine) base.publisherOpenid = openid
    cond = _.and([base, _.or([{ title: reg }, { plazaNo: reg }, { surface: reg }])])
  }

  const res = await db.collection('stories')
    .where(cond)
    .field({ _id: true, title: true, plazaNo: true, surface: true, publisherNickname: true, publisherOpenid: true, createdAt: true })
    .orderBy('createdAt', 'desc')
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .get()

  const stories = res.data.map(function (s) {
    return {
      _id: s._id,
      title: s.title,
      plazaNo: s.plazaNo,
      surface: s.surface,
      publisherNickname: s.publisherNickname,
      isMine: s.publisherOpenid === openid,
      createdAt: s.createdAt
    }
  })
  return ok({ stories: stories, hasMore: res.data.length === PAGE_SIZE })
}

// ---------- 详情（汤面 + 元信息，不含汤底） ----------
async function detail(event, openid) {
  const s = await getStory(String(event.id || ''))
  if (!s || s.source !== 'plaza') return err('故事不存在')
  return ok({
    story: {
      _id: s._id,
      title: s.title,
      plazaNo: s.plazaNo,
      surface: s.surface,
      publisherNickname: s.publisherNickname,
      isMine: s.publisherOpenid === openid,
      createdAt: s.createdAt
    }
  })
}

// ---------- 单题格式校验（不碰库、不调接口，纯同步） ----------
function validateOne(s, no) {
  const title = String(s.title || s.name || '').trim()
  const surface = String(s.surface || '').trim()
  const answer = String(s.answer || '').trim()
  const victory = String(s.victory_condition || '').trim()
  const additional = String(s.additional || '').trim()
  if (!title) return { error: '第 ' + no + ' 道：请填写故事名称' }
  if (!surface || !answer || !victory) return { error: '第 ' + no + ' 道：汤面 / 汤底 / 胜利条件为必填项' }
  if (title.length > 30) return { error: '第 ' + no + ' 道：故事名称最多 30 字' }
  return { data: { title: title, surface: surface, answer: answer, victory: victory, additional: additional } }
}

// ---------- 单题内容安全检测 ----------
async function checkOne(p, no, openid) {
  if (!(await secCheck(p.title + ' ' + p.surface + ' ' + p.answer, openid))) {
    return { error: '第 ' + no + ' 道：内容包含违规信息，请修改后再发布' }
  }
  return { data: p }
}

// ---------- 单题写库（编号已由 reserveNos 预分配） ----------
async function addOne(p, plazaNo, openid, nickname) {
  const add = await db.collection('stories').add({
    data: {
      source: 'plaza',
      title: p.title,
      plazaNo: plazaNo,
      surface: p.surface,
      answer: p.answer,
      additional: p.additional,
      victory_condition: p.victory,
      publisherOpenid: openid,
      publisherNickname: nickname || '匿名汤友',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
  return { id: add._id, plazaNo: plazaNo }
}

// ---------- 发布（在线填表 或 JSON 批量） ----------
// 三段式，为的是让 20 道题也能在云函数 3 秒超时内跑完：
//   ① 全量校验：纯同步，先把格式不合格的题挑出来，一条都不写库
//   ② 分组并发送检：每组 5 题同时调 msgSecCheck，20 题只需 4 轮往返
//   ③ 编号一次性预取 + 并发写库：10 道题只多 1 次事务开销
async function publish(event, openid) {
  const nickname = String(event.nickname || '').trim()
  let stories = event.stories
  if (!Array.isArray(stories)) {
    stories = [{
      title: event.title,
      surface: event.surface,
      answer: event.answer,
      additional: event.additional,
      victory_condition: event.victory_condition
    }]
  }
  if (!stories.length) return err('没有可发布的故事')
  if (stories.length > 20) return err('一次最多发布 20 道')

  // ① 全量校验
  const validated = []
  for (let i = 0; i < stories.length; i++) {
    const v = validateOne(stories[i] || {}, i + 1)
    if (v.error) return err(v.error + '（本批均未发布）')
    validated.push(v.data)
  }

  // ② 分组并发送检
  for (let g = 0; g < validated.length; g += 5) {
    const group = validated.slice(g, g + 5)
    const checked = await Promise.all(group.map(function (p, k) {
      return checkOne(p, g + k + 1, openid)
    }))
    for (let k = 0; k < checked.length; k++) {
      if (checked[k].error) return err(checked[k].error + '（本批均未发布）')
    }
  }

  // ③ 预取编号 + 并发写库
  const nos = await reserveNos(validated.length)
  const settled = await Promise.allSettled(validated.map(function (p, i) {
    return addOne(p, nos[i], openid, nickname)
  }))
  const results = []
  const failed = []
  settled.forEach(function (s, i) {
    if (s.status === 'fulfilled') results.push(s.value)
    else failed.push(i + 1)
  })
  if (failed.length) {
    return err('第 ' + failed.join('、') + ' 道写入失败' +
      (results.length ? '（已成功发布 ' + results.length + ' 道，失败 ' + failed.length + ' 道）' : '（本批均未发布）'))
  }
  return ok({ count: results.length, stories: results })
}

// ---------- 取编辑内容（仅发布者本人，返回完整汤底） ----------
async function getForEdit(event, openid) {
  const s = await getStory(String(event.id || ''))
  if (!s || s.source !== 'plaza') return err('故事不存在')
  if (s.publisherOpenid !== openid) return err('只有发布者本人可以编辑')
  return ok({
    story: {
      _id: s._id,
      title: s.title,
      plazaNo: s.plazaNo,
      surface: s.surface,
      answer: s.answer,
      additional: s.additional,
      victory_condition: s.victory_condition
    }
  })
}

// ---------- 编辑（仅发布者本人） ----------
async function edit(event, openid) {
  const id = String(event.id || '')
  const s = await getStory(id)
  if (!s || s.source !== 'plaza') return err('故事不存在')
  if (s.publisherOpenid !== openid) return err('只有发布者本人可以编辑')

  const title = String(event.title || '').trim()
  const surface = String(event.surface || '').trim()
  const answer = String(event.answer || '').trim()
  const victory = String(event.victory_condition || '').trim()
  const additional = String(event.additional || '').trim()
  if (!title || !surface || !answer || !victory) return err('名称 / 汤面 / 汤底 / 胜利条件为必填项')
  if (!(await secCheck(title + ' ' + surface + ' ' + answer, openid))) {
    return err('内容包含违规信息，请修改后再保存')
  }
  await db.collection('stories').doc(id).update({
    data: {
      title: title, surface: surface, answer: answer,
      additional: additional, victory_condition: victory,
      updatedAt: db.serverDate()
    }
  })
  return ok()
}

// ---------- 删除（仅发布者本人） ----------
async function remove(event, openid) {
  const id = String(event.id || '')
  const s = await getStory(id)
  if (!s || s.source !== 'plaza') return err('故事不存在')
  if (s.publisherOpenid !== openid) return err('只有发布者本人可以删除')
  await db.collection('stories').doc(id).remove()
  return ok()
}

// ---------- 入口路由 ----------
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  try {
    switch (event.action) {
      case 'list': return await list(event, OPENID)
      case 'detail': return await detail(event, OPENID)
      case 'publish': return await publish(event, OPENID)
      case 'getForEdit': return await getForEdit(event, OPENID)
      case 'edit': return await edit(event, OPENID)
      case 'remove': return await remove(event, OPENID)
      default: return err('未知操作: ' + event.action)
    }
  } catch (e) {
    console.error(e)
    return err('服务异常: ' + (e.message || e))
  }
}