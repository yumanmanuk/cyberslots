// Kimi Token Plan 额度守护（三个 server 共用，每进程一个实例）
//
// 每 KIMI_QUOTA_CHECK_INTERVAL_MS 轮询一次 KIMI_QUOTA_USAGES_URL，
// 在内存中维护 5 小时窗口与 7 天窗口的用量占比；任一窗口达到阈值时 exceeded=true，
// 由各 server 在路由决策后调用 shouldFallback() 把 limited 调用者的 Kimi 请求导流 MiniMax。
//
// 失败策略 fail-open（一律不限流）：
//   - 某窗口数据缺失          → 该窗口不参与判定
//   - 两个窗口都无数据        → 视为未超限
//   - 查询失败（网络/非2xx/解析）→ 保持上次状态；从未成功 → 未超限
const http = require('http')
const https = require('https')
const config = require('./config')

const REQUEST_TIMEOUT_MS = 15000

const state = {
  exceeded: false,
  fiveHourUtil: null,   // 5h 窗口用量占比（无数据为 null）
  weeklyUtil: null,     // 周窗口用量占比（无数据为 null）
  lastCheckAt: 0,       // 最后一次查询完成时间（无论成败）
  lastSuccessAt: 0,
  consecutiveErrors: 0,
}

let timer = null
let logger = null       // 各 server 注入自己的 writeLog，让守护日志进同一个日志文件
let usagesUrlOverride = null

function log(level, message, extra) {
  if (logger) logger(level, message, extra)
}

// ── 解析（对齐 cc-switch coding_plan.rs 的 query_kimi 逻辑）──────────────────

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// 单个限额对象的用量占比；数据缺失或 limit<=0 → null（该窗口不参与判定）
function utilizationOf(quota) {
  if (!quota || typeof quota !== 'object') return null
  const limit = toNum(quota.limit)
  const remaining = toNum(quota.remaining)
  if (limit == null || remaining == null || limit <= 0) return null
  return Math.max(0, limit - remaining) / limit
}

// 5h 窗口：limits[] 里每项 detail 的占比取最大值（任一小窗口打满都算超限）
function parseFiveHourUtil(body) {
  const limits = body && Array.isArray(body.limits) ? body.limits : []
  let max = null
  for (const item of limits) {
    const u = utilizationOf(item && item.detail)
    if (u != null && (max == null || u > max)) max = u
  }
  return max
}

// ── 状态更新与日志 ──────────────────────────────────────────────────────────

function percent(u) {
  return u == null ? null : Math.round(u * 1000) / 10
}

function applyUsage(body) {
  const fiveHourUtil = parseFiveHourUtil(body)
  const weeklyUtil = utilizationOf(body && body.usage)
  if (fiveHourUtil == null && weeklyUtil == null) {
    log('warn', 'Kimi usage 响应中无限额数据,本次按未超限处理')
  }
  state.fiveHourUtil = fiveHourUtil
  state.weeklyUtil = weeklyUtil
  const exceeded =
    (fiveHourUtil != null && fiveHourUtil >= config.KIMI_QUOTA_5H_THRESHOLD) ||
    (weeklyUtil != null && weeklyUtil >= config.KIMI_QUOTA_WEEKLY_THRESHOLD)
  if (exceeded !== state.exceeded) {
    state.exceeded = exceeded
    const extra = { fiveHour: percent(fiveHourUtil), weekly: percent(weeklyUtil) }
    log('warn', exceeded ? 'Kimi 用量超阈值,开启导流' : 'Kimi 用量恢复,停止导流', extra)
  }
}

// ── 轮询 ────────────────────────────────────────────────────────────────────

function fetchUsages(url, apiKey) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (e) {
          reject(new Error('响应非 JSON: ' + e.message))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`查询超时(${REQUEST_TIMEOUT_MS}ms)`)))
    req.on('error', reject)
  })
}

async function pollOnce() {
  try {
    const body = await fetchUsages(usagesUrlOverride || config.KIMI_QUOTA_USAGES_URL, config.KIMI_API_KEY)
    state.consecutiveErrors = 0
    state.lastSuccessAt = Date.now()
    applyUsage(body)
  } catch (e) {
    state.consecutiveErrors += 1
    // 不刷屏：连续失败只在首次记一条 error，查询成功后计数重置
    if (state.consecutiveErrors === 1) {
      log('error', 'Kimi usage 查询失败: ' + e.message)
    }
  } finally {
    state.lastCheckAt = Date.now()
  }
}

// 幂等启动。options 仅供测试/调试覆盖：{ log, usagesUrl, intervalMs }
function start(options = {}) {
  if (!config.KIMI_QUOTA_GUARD) return
  if (options.log) logger = options.log
  if (options.usagesUrl) usagesUrlOverride = options.usagesUrl
  if (timer) return
  pollOnce()
  timer = setInterval(pollOnce, options.intervalMs || config.KIMI_QUOTA_CHECK_INTERVAL_MS)
  timer.unref()  // 不阻碍进程退出
}

function stop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// ── 判定 ────────────────────────────────────────────────────────────────────

// 命中条件：开关开 && 调用者被限流 && 路由指向 Kimi && 当前超限
function shouldFallback(route, client) {
  if (!config.KIMI_QUOTA_GUARD) return false
  if (!client || client.limited !== true) return false
  if (!route || !String(route.baseUrl || '').includes('api.kimi.com')) return false
  return state.exceeded
}

function getState() {
  return Object.assign({}, state)
}

module.exports = { start, stop, shouldFallback, getState }