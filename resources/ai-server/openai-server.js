// openai-server.js — node:http2 透传版(OpenAI 协议)
// 改用 Node 原生 http2 + 持久 session, 复用 HTTP/2 多路复用
// 实测比 node https + Agent 快(MiniMax/DeepSeek 等走 HTTP/2 路径)
const http = require('http')
const http2 = require('http2')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const config = require('./config')
const { resolveClient, isAllowed } = require('./client-access')
const quotaGuard = require('./kimi-quota-guard')
const { resolveKimiEffort } = require('./kimi-effort')

// ========== 日志模块 ==========
const LOG_DIR = path.join(__dirname, 'logs')
const DATA_DIR = path.join(__dirname, 'data')

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
}
ensureDir(LOG_DIR)
ensureDir(DATA_DIR)

function writeLog(level, message, extra = {}) {
  const entry = { timestamp: new Date().toISOString(), level, service: 'ai-openai-http2-proxy', message, ...extra }
  const line = JSON.stringify(entry) + '\n'
  const filename = level === 'error' ? 'openai-http2-proxy-error.log' : 'openai-http2-proxy-combined.log'
  fs.appendFile(path.join(LOG_DIR, filename), line, () => {})
  if (level === 'error' || level === 'warn') {
    console.error(`[${level.toUpperCase()}] ${message}`, Object.keys(extra).length ? extra : '')
  }
}

// ========== 统计数据持久化 ==========
const STATS_FILE = path.join(DATA_DIR, 'openai-http2-stats.json')
let statsRecords = []

function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
    if (Array.isArray(data.records)) statsRecords = data.records
  } catch (_) {
    statsRecords = []
  }
}

function saveStats() {
  const tmp = STATS_FILE + '.tmp'
  fs.writeFile(tmp, JSON.stringify({ records: statsRecords }), (err) => {
    if (!err) fs.rename(tmp, STATS_FILE, () => {})
  })
}

let statsDirty = false
let statsTimer = null
function markStatsDirty() {
  statsDirty = true
  if (!statsTimer) {
    statsTimer = setTimeout(() => {
      statsTimer = null
      if (statsDirty) {
        statsDirty = false
        saveStats()
      }
    }, 5000)
  }
}

loadStats()

// ========== 旁路 Token 统计(OpenAI 格式) ==========
// 兼容流式(SSE)和非流式(JSON)两种格式
class TokenStats {
  constructor() { this.buffer = ''; this.inputTokens = 0; this.outputTokens = 0; this.cachedTokens = 0 }
  feed(chunk) {
    this.buffer += chunk.toString()
    const events = this.buffer.split('\n\n')
    this.buffer = events.pop()
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const trimmed = line.slice(5).trimStart()
        if (!trimmed || trimmed === '[DONE]') continue
        try {
          const data = JSON.parse(trimmed)
          this._absorbUsage(data.usage)
        } catch (_) {}
      }
    }
  }
  finalize(fullBody) {
    if (this.buffer.trim()) {
      try {
        const data = JSON.parse(this.buffer.trim().replace(/^data:\s*/, ''))
        this._absorbUsage(data.usage)
      } catch (_) {}
      this.buffer = ''
    }
    if (fullBody) {
      try { const data = JSON.parse(fullBody); this._absorbUsage(data.usage) } catch (_) {}
    }
  }
  _absorbUsage(u) {
    if (!u) return
    if (u.prompt_tokens != null) this.inputTokens = u.prompt_tokens
    if (u.input_tokens != null) this.inputTokens = u.input_tokens
    if (u.completion_tokens != null) this.outputTokens = u.completion_tokens
    if (u.output_tokens != null) this.outputTokens = u.output_tokens
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
      || (u.input_tokens_details && u.input_tokens_details.cached_tokens)
      || u.cached_tokens
    if (cached != null) this.cachedTokens = cached
  }
  getUsage() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: this.cachedTokens,
      totalTokens: this.inputTokens + this.outputTokens,
    }
  }
}

// 输入 token 数字格式：>=1k 用 k 表示（整数 32k；有小数 32.5k）；<1k 保留 1 位小数（0.1k）
function humanizeTokens(n) {
  n = Number(n) || 0
  if (n < 0) return '0'
  // 输入 token：>=1k 用 k 表示（整数去掉小数,有小数保留 1 位）；<1k 也保留 1 位小数
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

// 按终端显示宽度补空格对齐（中文/全角字符占 2 列）
function dispWidth(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
function padStartW(s, width) {
  s = String(s)
  const p = width - dispWidth(s)
  return p > 0 ? ' '.repeat(p) + s : s
}
function padEndW(s, width) {
  s = String(s)
  const p = width - dispWidth(s)
  return p > 0 ? s + ' '.repeat(p) : s
}

// 按显示宽度截断(超宽末尾加省略号, 防止长模型名/客户端名顶歪日志列)
function truncW(s, width) {
  s = String(s)
  if (dispWidth(s) <= width) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = dispWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + String.fromCharCode(0x2026)
}

function recordRequestLog({ startTime, status, modelName, clientName, route, stats, upstreamStatusCode }) {
  const elapsed = (Date.now() - startTime) / 1000
  const usage = stats.getUsage ? stats.getUsage() : stats
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const displayName = padEndW(truncW(String(modelName || route.name).toLowerCase(), 16), 16)
  const displayClient = padEndW(truncW(clientName, 8), 8)
  const sec = `${elapsed.toFixed(2)}s`.padStart(7)
  const fmt = (n) => padStartW(humanizeTokens(n), 13)
  const fmtOut = (n) => (Number(n) || 0).toLocaleString('en-US').padStart(8)
  if (status === 'ok') {
    const cachePct = usage.inputTokens > 0 ? (usage.cachedTokens / usage.inputTokens * 100).toFixed(2) : '0.00'
    const cacheStr = usage.cachedTokens > 0 ? `(${padStartW(cachePct, 7)}%)` : padEndW('', 10)
    const tps = elapsed > 0 ? Math.round(usage.outputTokens / elapsed) : 0
    const tpsStr = `${tps} t/s`.padStart(7)
    console.log(`[${ts}] ${displayClient} → ${displayName} | ${upstreamStatusCode || 200} ${tpsStr} ${sec} |     in:${fmt(usage.inputTokens)}  ${cacheStr}  out:${fmtOut(usage.outputTokens)}`)
  } else if (status === 'cancelled') {
    console.log(`[${ts}] ${displayClient} → ${displayName} | 取消   ${sec}`)
  } else {
    console.log(`[${ts}] ${displayClient} → ${displayName} | 失败   ${sec}`)
  }

  statsRecords.push({
    time: new Date().toISOString(),
    name: clientName,
    model: modelName,
    route: route.name,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    totalTokens: usage.totalTokens,
    elapsed,
    status,
  })
  if (statsRecords.length > 5000) statsRecords = statsRecords.slice(-5000)
  markStatsDirty()
}

// ========== 获取真实客户端 IP ==========
// 客户端识别已抽到 client-access.js（IP 名单 + limited 限流标记），这里保留薄封装
function getClientIp(req) { return resolveClient(req).ip }
function getClientName(req) { return resolveClient(req).name }

function checkIpWhitelist(req, res) {
  const clientIp = getClientIp(req)
  const allowed = isAllowed(clientIp)
  if (!allowed) {
    writeLog('warn', `IP ${clientIp} 不在白名单中`, { ip: clientIp })
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Forbidden: IP not in whitelist' }))
    return false
  }
  return true
}

// 读取完整请求体(回调式,不阻塞事件循环)
function readBodyCb(req, cb) {
  const chunks = []
  let aborted = false
  req.on('data', c => { if (!aborted) chunks.push(c) })
  req.on('end', () => cb(null, Buffer.concat(chunks)))
  req.on('error', err => { aborted = true; cb(err, null) })
  req.on('aborted', () => { aborted = true; cb(new Error('aborted'), null) })
}

// 根据模型名称或 URL 路径决定路由目标
const ROUTE_TABLE = [
  { key: 'glm',      name: 'GLM',      baseUrl: config.GLM_OPENAI_BASE_URL,      apiKey: config.GLM_API_KEY },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: config.DEEPSEEK_OPENAI_BASE_URL, apiKey: config.DEEPSEEK_API_KEY },
  { key: 'k3',      name: 'Kimi',     baseUrl: config.KIMI_OPENAI_BASE_URL,     apiKey: config.KIMI_API_KEY },
  { key: 'kimi',     name: 'Kimi',     baseUrl: config.KIMI_OPENAI_BASE_URL,     apiKey: config.KIMI_API_KEY },
  { key: 'minimax',  name: 'MiniMax',  baseUrl: config.MINIMAX_OPENAI_BASE_URL,  apiKey: config.MINIMAX_API_KEY },
]

// Kimi 额度守护导流目标
const MINIMAX_ROUTE = ROUTE_TABLE.find(r => r.key === 'minimax')

function resolveRoute(model) {
  if (!model) return null
  const lower = model.toLowerCase()
  for (const r of ROUTE_TABLE) {
    if (lower.includes(r.key)) return r
  }
  return null
}

function resolveRouteByPath(url) {
  for (const r of ROUTE_TABLE) {
    const prefix = '/' + r.key
    if (url.startsWith(prefix + '/') || url === prefix) {
      const rest = url.slice(prefix.length) || '/'
      return { route: r, rewritePath: rest }
    }
  }
  return null
}

// Kimi /coding/ 端点无需 model 字段,转发前移除
function stripModelField(bodyBuffer) {
  try {
    const body = JSON.parse(bodyBuffer.toString())
    delete body.model
    return Buffer.from(JSON.stringify(body))
  } catch (_) {
    return bodyBuffer
  }
}
// Kimi: 按客户端模型名区分 k3 / 高速版 / 普通版（与 codex-server 的 resolveUpstreamModel 一致）
//   含 "k3" → k3；同时含 "kimi" + "highspeed" → kimi-for-coding-highspeed；其余 → kimi-for-coding
function resolveKimiModel(clientModel) {
  const m = String(clientModel || '').toLowerCase()
  if (m.includes('k3')) return 'k3'
  if (m.includes('kimi') && m.includes('highspeed')) return 'kimi-for-coding-highspeed'
  return 'kimi-for-coding'
}
// Kimi 日志显示名：k3 → "kimi k3"，highspeed → "kimi speed"，其余 → "kimi"
function kimiDisplayName(clientModel) {
  const m = String(clientModel || '').toLowerCase()
  if (m.includes('k3')) return 'kimi k3'
  if (m.includes('kimi') && m.includes('highspeed')) return 'kimi speed'
  return 'kimi'
}
function setModelField(bodyBuffer, model) {
  try {
    const body = JSON.parse(bodyBuffer.toString())
    body.model = model
    return Buffer.from(JSON.stringify(body))
  } catch (_) {
    return bodyBuffer
  }
}

// ========== 持久 http2 session 池(origin → session) ==========
const h2Sessions = new Map()
const H2_IDLE_TIMEOUT_MS = 5 * 60 * 1000  // 5 分钟 idle 就主动关

function closeSession(origin, reason) {
  const s = h2Sessions.get(origin)
  if (!s) return
  h2Sessions.delete(origin)
  if (s._idleTimer) clearTimeout(s._idleTimer)
  try { s.close() } catch (_) {}
  try { s.destroy() } catch (_) {}
  if (reason) writeLog('info', `h2 session closed: ${reason}`, { origin })
}

function isSessionAlive(s) {
  if (!s) return false
  if (s.destroyed) return false
  if (s.closed) return false
  const socket = s.socket
  if (socket && (socket.destroyed || socket.readableEnded || socket.writableEnded)) return false
  return true
}

function getH2Session(origin) {
  const existing = h2Sessions.get(origin)
  if (isSessionAlive(existing)) {
    // 重置 idle 计时器
    if (existing._idleTimer) clearTimeout(existing._idleTimer)
    existing._idleTimer = setTimeout(() => {
      closeSession(origin, 'idle')
    }, H2_IDLE_TIMEOUT_MS)
    return existing
  }
  if (existing) closeSession(origin, 'stale')

  const session = http2.connect(origin)
  session.on('error', err => {
    writeLog('warn', `h2 session err: ${err.message}`, { origin, code: err.code })
    closeSession(origin, 'error')
  })
  session.on('close', () => closeSession(origin, 'close'))
  session.on('goaway', (errorCode, lastStreamID) => {
    writeLog('info', `h2 goaway code=${errorCode} lastStream=${lastStreamID}`, { origin })
    closeSession(origin, 'goaway')
  })
  // idle 超时
  session._idleTimer = setTimeout(() => {
    closeSession(origin, 'idle')
  }, H2_IDLE_TIMEOUT_MS)
  h2Sessions.set(origin, session)
  return session
}

// 防止下游客户端（如 Opencode）因 assistant content 为空而校验失败
function patchEmptyAssistantContent(obj) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!choice) continue
      if (choice.message && choice.message.content === '') choice.message.content = ' '
      if (choice.delta && choice.delta.content === '') choice.delta.content = ' '
    }
  }
}

function patchJsonResponse(raw) {
  try {
    const data = JSON.parse(raw)
    patchEmptyAssistantContent(data)
    return JSON.stringify(data)
  } catch (_) {
    return raw
  }
}

function patchSseBlock(block) {
  if (!block || !block.trim()) return block
  const lines = block.split('\n')
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trimStart()
      if (payload && payload !== '[DONE]') {
        try {
          const data = JSON.parse(payload)
          patchEmptyAssistantContent(data)
          out.push('data: ' + JSON.stringify(data))
          continue
        } catch (_) {}
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

// ========== 用 node:http2 转发 ==========
function forwardWithHttp2({ method, url, headers, body, route, modelName, req, res }) {
  const startTime = Date.now()

  const urlObj = new URL(url)
  const origin = urlObj.origin
  const path = urlObj.pathname + (urlObj.search || '')

  const session = getH2Session(origin)

  const stats = new TokenStats()
  let finished = false
  let upstreamStatusCode = 0
  const clientName = getClientName(req)

  function finish(status) {
    if (finished) return
    finished = true
    recordRequestLog({ startTime, status, modelName, clientName, route, stats, upstreamStatusCode })
  }

  // 客户端中途断用 aborted(close 在 res.end 后也会触发,会误判)
  let cancelled = false
  req.on('aborted', () => {
    if (!finished && !cancelled) {
      cancelled = true
      try { h2Req.close(http2.constants.NGHTTP2_CANCEL) } catch (_) {}
      finish('cancelled')
    }
  })

  // 构造 h2 头
  const h2Headers = {
    ':method': method,
    ':path': path,
    'content-type': 'application/json',
  }
  // HTTP/2 禁用的 HTTP/1.1 特定头
  const h2Forbidden = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te'])
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'host' || k === ':authority') continue
    if (h2Forbidden.has(k.toLowerCase())) continue
    h2Headers[k] = v
  }

  const h2Req = session.request(h2Headers)
  let bodyBuf = Buffer.alloc(0)
  let isStreaming = false
  let sseBuf = ''
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

  h2Req.on('response', h2resp => {
    upstreamStatusCode = h2resp[':status']
    // 转换 h2 头到 node http 头(去掉 :开头的伪头)
    const responseHeaders = {}
    for (const [k, v] of Object.entries(h2resp)) {
      if (k.startsWith(':')) continue
      responseHeaders[k] = v
    }
    const ct = (responseHeaders['content-type'] || '').toLowerCase()
    isStreaming = ct.includes('text/event-stream')
    responseHeaders['access-control-allow-origin'] = '*'
    try {
      res.writeHead(upstreamStatusCode, responseHeaders)
      res.flushHeaders && res.flushHeaders()
    } catch (err) {
      writeLog('warn', `writeHead 失败: ${err.message}`, { route: route.name, status: upstreamStatusCode })
      try { h2Req.close() } catch (_) {}
      finish('error')
      return
    }
  })

  h2Req.on('data', chunk => {
    stats.feed(chunk)
    bodyBuf = Buffer.concat([bodyBuf, chunk])
    if (isStreaming) {
      sseBuf += utf8Decoder.decode(chunk, { stream: true })
      const blocks = sseBuf.split('\n\n')
      sseBuf = blocks.pop() || ''
      for (const block of blocks) {
        if (!block.trim()) continue
        const patched = patchSseBlock(block)
        try { res.write(patched + '\n\n') } catch (_) {}
      }
    }
    // 非流式响应在 end 时统一 patch 后再发送
  })

  h2Req.on('end', () => {
    if (isStreaming) {
      sseBuf += utf8Decoder.decode()
      if (sseBuf.trim()) {
        const patched = patchSseBlock(sseBuf.trim())
        try { res.write(patched + '\n\n') } catch (_) {}
      }
      if (bodyBuf.length > 0) stats.finalize(bodyBuf.toString())
    } else {
      if (bodyBuf.length > 0) {
        const raw = bodyBuf.toString('utf8')
        const patched = patchJsonResponse(raw)
        stats.finalize(patched)
        try { res.write(patched) } catch (_) {}
      }
    }
    try { res.end() } catch (_) {}
    finish('ok')
  })

  h2Req.on('error', err => {
    writeLog('error', `[${route.name}] h2 错误: ${err.message}`, { code: err.code })
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
      } catch (_) {}
    } else {
      // 已经写了 headers,client 不知道出错,必须 destroy socket
      try { res.destroy() } catch (_) {}
    }
    finish('error')
  })

  h2Req.on('frameError', (type, code) => {
    writeLog('warn', `[${route.name}] h2 frameError: type=${type} code=${code}`)
  })

  if (body && body.length > 0) {
    h2Req.write(body)
  }
  h2Req.end()
}

function handleForward(req, res, route, bodyBuffer, modelName) {
  const lowerModel = String(modelName || '').toLowerCase()
  const originalModelName = modelName  // 下方会改名用于日志展示，这里保留客户端原始模型名（k3-low 等后缀解析要用）
  // Kimi: 按客户端模型名选择 k3 / 高速版 / 普通版（与 codex 一致）
  if (route.name === 'Kimi' && bodyBuffer.length > 0) {
    bodyBuffer = setModelField(bodyBuffer, resolveKimiModel(modelName))
  }
  // Kimi 路由：日志显示名规范化为 kimi k3 / kimi speed / kimi
  if (route.name === 'Kimi') modelName = kimiDisplayName(modelName)

  // k3 思考程度：请求体 reasoning_effort > 模型名后缀 > config 默认 > low（归一化为 low/high/max）
  // effort 始终有值 → 思考始终开启（关思考会被上游路由到其他模型）
  // 注意 route.name === 'Kimi' 条件：额度守护导流 MiniMax 后模型名仍含 k3（"kimi k3→m3"），不能误注入
  if (route.name === 'Kimi' && lowerModel.includes('k3') && bodyBuffer.length > 0) {
    try {
      const bodyObj = JSON.parse(bodyBuffer.toString())
      bodyObj.reasoning_effort = resolveKimiEffort({ raw: bodyObj.reasoning_effort, clientModel: originalModelName, defaultEffort: config.KIMI_K3_EFFORT })
      // K3 固定参数（temperature=1.0 / top_p=0.95 / n=1 / penalties=0），官方建议不要显式传入 → 剥离
      delete bodyObj.temperature
      delete bodyObj.top_p
      delete bodyObj.n
      delete bodyObj.presence_penalty
      delete bodyObj.frequency_penalty
      bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
    } catch (_) {}
  }

  // DeepSeek 强制 reasoning_effort = max
  if (route.key === 'deepseek' && bodyBuffer.length > 0) {
    try {
      const bodyObj = JSON.parse(bodyBuffer.toString())
      bodyObj.reasoning_effort = 'max'
      bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
    } catch (_) {}
  }

  // MiniMax 启用 reasoning_split：让 thinking 拆到 delta.reasoning_content 独立字段
  // 否则 thinking 被嵌入到 content 里(<think>...</think>),客户端无法识别
  // 仅 M3 生效,M2.x 模型忽略该字段(官方说明)
  if (route.key === 'minimax' && bodyBuffer.length > 0) {
    try {
      const bodyObj = JSON.parse(bodyBuffer.toString())
      bodyObj.reasoning_split = true
      // minimax + highspeed → MiniMax-M2.7-highspeed
      if (lowerModel.includes('minimax') && lowerModel.includes('highspeed')) {
        bodyObj.model = 'MiniMax-M2.7-highspeed'
      }
      bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
    } catch (_) {}
  }

  // 流式请求必须显式声明 include_usage,否则 OpenAI 兼容上游(MiniMax/DeepSeek/GLM/Kimi 等)
  // 不会在末尾 SSE 中吐 usage 块,导致 token/成本统计全为 0
  if (bodyBuffer.length > 0) {
    try {
      const bodyObj = JSON.parse(bodyBuffer.toString())
      if (bodyObj.stream === true) {
        bodyObj.stream_options = Object.assign({}, bodyObj.stream_options, { include_usage: true })
        bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
      }
    } catch (_) {}
  }

  const targetUrlStr = route.baseUrl + req.url
  // baseUrl 已有 /v1,客户端发的 /v1/chat/completions 会导致 /v1/v1/chat/completions
  // 剥掉路径里的 /v1 前缀
  const finalUrl = targetUrlStr.replace(/\/v1\/v1\//, '/v1/').replace(/\/v1\/v1$/, '/v1')

  const forwardHeaders = {}
  // 不透传 accept-encoding:上游可能返回 br/gzip 压缩响应,代理本身不实现解压,
  // 透传会导致客户端解压失败,同时压缩流也破坏了 stats.feed 的 JSON.parse。
  // localhost 代理场景,压缩无意义,统一用 identity。
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === 'content-length' || k === 'accept-encoding') continue
    forwardHeaders[k] = v
  }
  forwardHeaders['content-type'] = 'application/json'
  if (route.apiKey) {
    forwardHeaders['authorization'] = `Bearer ${route.apiKey}`
  }

  forwardWithHttp2({ method: req.method, url: finalUrl, headers: forwardHeaders, body: bodyBuffer, route, modelName, req, res })
}

// ========== 主入口 ==========
function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    res.end()
    return
  }

  if (req.method === 'HEAD') {
    res.writeHead(200)
    res.end()
    return
  }

  if (!checkIpWhitelist(req, res)) return

  // GET 请求按 URL 路径前缀路由
  if (req.method === 'GET') {
    const matched = resolveRouteByPath(req.url)
    if (!matched) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unknown route', message: `GET 路径 "${req.url}" 无法匹配路由` }))
      return
    }
    writeLog('info', `路由: GET ${req.url} → ${matched.route.name}`, { ip: getClientIp(req), name: getClientName(req) })
    const origUrl = req.url
    req.url = matched.rewritePath
    handleForward(req, res, matched.route, Buffer.alloc(0), '')
    req.url = origUrl
    return
  }

  // POST/PUT/PATCH: 读 body 用于路由决策
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    readBodyCb(req, (err, bodyBuffer) => {
      if (err) {
        writeLog('error', `读取请求体失败: ${err.message}`, { code: err.code })
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }))
        } else { res.end() }
        return
      }

      let model = null
      if (bodyBuffer.length > 0) {
        try { model = JSON.parse(bodyBuffer.toString()).model } catch (_) {}
      }

      let route = resolveRoute(model)
      if (!route) {
        const hint = model ? `模型 "${model}" 无法匹配任何路由` : '请求体中未找到 model 字段'
        writeLog('warn', `路由失败: ${hint}`, { model })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unknown model', message: hint }))
        return
      }

      // Kimi 额度守护：超限且调用者被限流 → 静默导流 MiniMax（显示名加 →m3 后缀便于现场分辨）
      const client = resolveClient(req)
      if (quotaGuard.shouldFallback(route, client)) {
        const displayFrom = kimiDisplayName(model)
        route = MINIMAX_ROUTE
        bodyBuffer = setModelField(bodyBuffer, config.KIMI_QUOTA_FALLBACK_MODEL)
        model = displayFrom + '→m3'
      }

      // k3 显示名带思考深度括号：kimi k3(max)
      let displayModel = model
      if (route.name === 'Kimi' && String(model || '').toLowerCase().includes('k3')) {
        let rawEffort
        try { rawEffort = JSON.parse(bodyBuffer.toString()).reasoning_effort } catch (_) {}
        displayModel = kimiDisplayName(model) + '(' + resolveKimiEffort({ raw: rawEffort, clientModel: model, defaultEffort: config.KIMI_K3_EFFORT }) + ')'
      }
      writeLog('info', `路由: ${displayModel} → ${route.name}`, { ip: client.ip, name: client.name })
      handleForward(req, res, route, bodyBuffer, model || '')
    })
    return
  }

  res.writeHead(405, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Method Not Allowed' }))
}

// 端口优先级: env var > config.OPENAI_PORT > 默认 3719
const PORT = process.env.OPENAI_PORT_OVERRIDE
  ? Number(process.env.OPENAI_PORT_OVERRIDE)
  : (config.OPENAI_PORT || 3719)
const server = http.createServer(handleRequest)
server.on('connection', socket => socket.setNoDelay(true))

server.on('clientError', (err, socket) => {
  const quiet = err.code === 'ECONNRESET' || err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
  writeLog(quiet ? 'info' : 'error', `客户端请求异常: ${err.message}`, { code: err.code })
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

process.on('uncaughtException', (err, origin) => {
  writeLog('error', `未捕获异常 (${origin}): ${err.message}`, { name: err.name, code: err.code, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  writeLog('error', `未处理的 Promise Rejection: ${err.message}`, { name: err.name, code: err.code, stack: err.stack })
})

server.listen(PORT, () => {
  const banner = [
    `🚀 OpenAI 兼容 API (node:http2 透传) 代理服务器已启动`,
    `   地址: http://localhost:${PORT}`,
  ].join('\n')
  console.log('\n' + banner + '\n')
  writeLog('info', 'OpenAI 兼容 API (node:http2 透传) 代理服务器已启动', { port: PORT })
  quotaGuard.start({ log: writeLog })
})
