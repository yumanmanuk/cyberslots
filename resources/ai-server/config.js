// config.js — env-backed shim for the embedded CyberSlots proxy.
//
// The upstream ai-server reads a hand-written config.js; inside CyberSlots
// every value is injected through the environment by AiServerHost so that
// API keys never touch the disk. Team-sharing features (quota guard,
// member log, client whitelist beyond loopback) stay disabled — only the
// Responses↔Chat conversion core is used (方案 §内置 ai-server 裁剪).
module.exports = {
  CODEX_PORT: Number(process.env.CODEX_PORT_OVERRIDE || 3722),

  KIMI_OPENAI_BASE_URL: process.env.KIMI_OPENAI_BASE_URL || 'https://api.kimi.com/coding/v1',
  KIMI_API_KEY: process.env.KIMI_API_KEY || '',
  MINIMAX_OPENAI_BASE_URL: process.env.MINIMAX_OPENAI_BASE_URL || 'https://api.minimaxi.com/v1',
  MINIMAX_ANTHROPIC_BASE_URL: process.env.MINIMAX_ANTHROPIC_BASE_URL || 'https://api.minimaxi.com/anthropic',
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || '',

  KIMI_K3_EFFORT: process.env.KIMI_K3_EFFORT || 'high',
  WEB_SEARCH_MAX_RESULT_LEN: Number(process.env.WEB_SEARCH_MAX_RESULT_LEN || 4000),
  KIMI_QUOTA_FALLBACK_MODEL: process.env.KIMI_QUOTA_FALLBACK_MODEL || 'MiniMax-M3',

  // Quota guard is a team-sharing feature — disabled in the embedded build.
  KIMI_QUOTA_GUARD: false,
  KIMI_QUOTA_USAGES_URL: '',
  KIMI_QUOTA_5H_THRESHOLD: 1,
  KIMI_QUOTA_WEEKLY_THRESHOLD: 1,
  KIMI_QUOTA_CHECK_INTERVAL_MS: 3600000,

  // Loopback only — the proxy is a private sidecar of the desktop app.
  IP_ACCESS: [
    { ip: '127.0.0.1', name: 'cyberslots', limited: false },
    { ip: '::1', name: 'cyberslots', limited: false },
  ],
}
