// 通用小工具

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 消息时间：当天只显示 时:分，跨天显示 月-日 时:分
function formatTime(t) {
  if (!t) return ''
  const d = new Date(t)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (d.toDateString() === now.toDateString()) return hm
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm
}

function docTime(d) {
  const t = new Date(d).getTime()
  return isNaN(t) ? 0 : t
}

// 数据库文档按创建时间排序（时间相同按 _id 兜底，保证顺序稳定）
function docSort(a, b) {
  const diff = docTime(a.createdAt) - docTime(b.createdAt)
  if (diff !== 0) return diff
  return a._id < b._id ? -1 : 1
}

// 群聊 @提及 高亮：把文本切成片段，命中成员昵称的 @片段 标记 mention
function mentionSegments(content, nicknames) {
  if (!content) return []
  const parts = String(content).split(/(@[^\s@:：,，。!?！？]{1,12})/g)
  const names = nicknames || []
  return parts
    .filter(function (p) { return p !== '' })
    .map(function (p, i) {
      return {
        i: i,
        text: p,
        mention: p.charAt(0) === '@' && names.indexOf(p.slice(1)) > -1
      }
    })
}

module.exports = {
  formatTime: formatTime,
  docSort: docSort,
  mentionSegments: mentionSegments
}