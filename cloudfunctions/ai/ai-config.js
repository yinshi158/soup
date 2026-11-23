// ============================================================
// AI 接口配置（移植自旧项目 Turtle_Soup/config.json 的 options）
// 这个文件只存在于云端云函数里，Key 不会下发到玩家手机。
//
// 如需更换接口 / Key / 模型：改这里，然后重新部署 ai 云函数。
// 提示：若调用时报"模型不存在"，把 model 改成 'deepseek-chat' 试试。
// ============================================================
module.exports = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'process.env.DEEPSEEK_API_KEY || ""',
  model: 'deepseek-flash'
}