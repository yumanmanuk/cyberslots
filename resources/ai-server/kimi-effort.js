// Kimi K3 思考程度（effort）归一化
//
// 背景：K3 上游只认 low / high / max 三档，官方映射规则：
//   null / undefined        → high（上游默认）
//   ultra / max / xhigh     → max
//   high / medium           → high
//   low  / minimum / light  → low
//   其他未知取值             → HTTP 400 报错
// 代理侧统一归一化后再转发：显式传入但无法识别的取值 → low
// （保证 effort 始终有值、思考始终开启；关思考会被上游路由到 K2.6）
// 注意 Codex CLI 发的是 minimal（官方表里写 minimum），这里一并兼容。

const EFFORT_ALIASES = {
  max: 'max', ultra: 'max', xhigh: 'max',
  high: 'high', medium: 'high',
  low: 'low', minimum: 'low', minimal: 'low', light: 'low',
}

// 归一化单个 effort 取值：返回 'low' | 'high' | 'max' | null（未提供/无法识别）
function mapKimiEffort(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  return EFFORT_ALIASES[String(raw).trim().toLowerCase()] || null
}

// 从客户端模型名解析 effort 后缀：kimi-k3-low / k3-high / kimi-k3-max ...
// 给不方便传 effort 字段的客户端（如 Claude Code 只能改模型名）一个切档入口
function effortFromModelName(clientModel) {
  const m = String(clientModel || '').toLowerCase()
  const match = m.match(/k3[-_. ](low|high|max)/)
  return match ? match[1] : null
}

// k3 最终 effort 决策：
//   - 显式传入：能识别 → 映射；不能识别 → low（策略：未知深度落 low）
//   - 未传入：模型名后缀 > 配置默认 > low
// 返回值保证为 'low' | 'high' | 'max'（不为 null），确保思考始终开启
function resolveKimiEffort({ raw, clientModel, defaultEffort } = {}) {
  if (raw !== null && raw !== undefined && raw !== '') {
    return mapKimiEffort(raw) || 'low'
  }
  return effortFromModelName(clientModel)
      || mapKimiEffort(defaultEffort)
      || 'low'
}

module.exports = { mapKimiEffort, effortFromModelName, resolveKimiEffort }
