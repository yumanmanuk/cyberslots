// 客户端访问识别：IP 白名单 + 限流标记（三个 server 共用）
// 名单见 config.js 的 IP_ACCESS：
//   name 仅用于日志展示；limited=true 的调用者在 Kimi 额度超限时被导流 MiniMax
const config = require('./config')

// x-forwarded-for 取首个 IP，剥 ::ffff: 前缀
function extractIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for']
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket && req.socket.remoteAddress
  return String(ip || '').replace(/^::ffff:/, '')
}

function findEntry(ip) {
  return config.IP_ACCESS.find(entry => entry.ip === ip) || null
}

// → { ip, name, limited }；未匹配 IP：name 回退为 IP 本身，limited=false（且会被白名单挡掉）
function resolveClient(req) {
  const ip = extractIp(req)
  const entry = findEntry(ip)
  if (!entry) return { ip, name: ip, limited: false }
  return { ip, name: entry.name, limited: entry.limited === true }
}

// 白名单：名单中出现即放行（调用方自行剥 ::ffff: 前缀与否均可）
function isAllowed(ip) {
  return findEntry(String(ip || '').replace(/^::ffff:/, '')) !== null
}

module.exports = { resolveClient, isAllowed }