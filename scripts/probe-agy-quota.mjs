/**
 * probe-agy-quota.mjs — Antigravity 额度链路只读探针（AntigravityAdapter/额度服务实现前的门禁）。
 *
 * 全程只读 + 不消耗推理额度，验证三件事（对应集成方案验证点）：
 *  1. refresh_token → access_token 刷新链路可用，且刷新响应回带 id_token
 *     （化解「cockpit 导出只有 refresh_token、缺 id_token」的顾虑）。
 *  2. loadCodeAssist 能拿到 project_id + 订阅档位。
 *  3. retrieveUserQuotaSummary 返回结构（weekly + 5h bucket），供额度看板/调度算法建模。
 *
 * 凭据来源：默认读本机 ~/.gemini/oauth_creds.json 的 refresh_token；
 * 也可传 --rt <refresh_token> 直接指定（用于测第二个账号，验证「文件级换号」的刷新侧）。
 *
 * ⚠️ 双 OAuth client（实测 2026-07 修正）：
 *   - 【antigravity_enterprise】1071006060591-… —— **agy keyring 与 cockpit 同用此 client**
 *     （id_token aud 铁证）。cockpit 账号库 + agy keyring 的 refresh_token 均归属它，用 --enterprise 刷。
 *   - 【gemini-cli】681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j —— 仅陈旧 ~/.gemini/oauth_creds.json
 *     里的历史凭据，**当前 headless agy 不用它**（先前误判 agy 归属此 client，已在集成文档 §5 修正）。
 *   refresh_token 只能用签发它的 client 刷新，跨 client 会 401 unauthorized_client。
 *
 * 用法：
 *   node scripts/probe-agy-quota.mjs                 # 用本机 ~/.gemini 账号（gemini-cli client）
 *   node scripts/probe-agy-quota.mjs --rt "1//0g..." # 指定 refresh_token
 *   node scripts/probe-agy-quota.mjs --enterprise    # 用 cockpit antigravity_enterprise client 刷新
 *   node scripts/probe-agy-quota.mjs --prod          # 强制走 prod base（默认先 daily 再回退 prod）
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getEnterpriseClient, getGeminiCliClient } from './agyClients.mjs';

const USE_ENTERPRISE = process.argv.includes('--enterprise');
// OAuth client 凭据从 agyClients.mjs 加载（环境变量或 gitignored .dev/agy-clients.json），不硬编码机密
const _gcli = getGeminiCliClient();   // gemini-cli 公共 client
const _ent = getEnterpriseClient();   // cockpit antigravity_enterprise client
const GEMINI_CLI_ID = _gcli.id;
const GEMINI_CLI_SECRET = _gcli.secret;
const ENTERPRISE_ID = _ent.id;
const ENTERPRISE_SECRET = _ent.secret;
const CLIENT_ID = USE_ENTERPRISE ? ENTERPRISE_ID : GEMINI_CLI_ID;
const CLIENT_SECRET = USE_ENTERPRISE ? ENTERPRISE_SECRET : GEMINI_CLI_SECRET;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BASE_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const BASE_PROD = 'https://cloudcode-pa.googleapis.com';
const UA = 'antigravity/1.20.5 windows/amd64';
const UA_LOAD = 'antigravity/1.20.5 windows/amd64 google-api-nodejs-client/10.3.0';
const X_GOOG = 'gl-node/22.21.1';

const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);
const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const redact = (s) => (typeof s === 'string' && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})` : s);

// ---------------------------------------------------------------- 0. 取 refresh_token
let refreshToken = argVal('--rt');
if (!refreshToken) {
  const credsPath = join(homedir(), '.gemini', 'oauth_creds.json');
  try {
    const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    refreshToken = creds.refresh_token;
    log('凭据来源:', credsPath);
    log('本机凭据字段:', Object.keys(creds).join(', '));
    log('本机 oauth_creds.json 是否含 id_token:', creds.id_token ? '是' : '否');
  } catch (e) {
    console.error('[probe] FAIL: 读不到 ~/.gemini/oauth_creds.json，且未传 --rt。', e.message);
    process.exit(1);
  }
}
if (!refreshToken) {
  console.error('[probe] FAIL: 无 refresh_token');
  process.exit(1);
}

// ---------------------------------------------------------------- 1. 刷新 access_token
section('1. refresh_token → access_token（验 id_token 回带）');
log('OAuth client:', USE_ENTERPRISE ? 'antigravity_enterprise (1071006060591)' : 'gemini-cli (681255809395)');
const form = new URLSearchParams({
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  refresh_token: refreshToken,
  grant_type: 'refresh_token',
});
const tokRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form.toString(),
});
log('token 端点状态:', tokRes.status);
if (!tokRes.ok) {
  console.error('[probe] FAIL: 刷新失败:', (await tokRes.text()).slice(0, 500));
  process.exit(1);
}
const tok = await tokRes.json();
const accessToken = tok.access_token;
log('access_token:', redact(accessToken));
log('expires_in:', tok.expires_in, 's');
log('token_type:', tok.token_type);
log('scope:', tok.scope);
log('★ 刷新响应是否回带 id_token:', tok.id_token ? `是 → ${redact(tok.id_token)}` : '否');
log('  → 结论：写 oauth_creds.json 时可用此新 id_token 补全（验证点①的 id_token 顾虑）');

// ---------------------------------------------------------------- 2. loadCodeAssist → project_id
const forceProd = process.argv.includes('--prod');
const metadata = {
  ideName: 'antigravity',
  ideType: 'ANTIGRAVITY',
  ideVersion: '1.20.5',
  pluginVersion: '1.20.5',
  platform: 'WINDOWS_AMD64',
  updateChannel: 'stable',
  pluginType: 'GEMINI',
};

async function loadCodeAssist(base) {
  const res = await fetch(`${base}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': UA_LOAD,
      'x-goog-api-client': X_GOOG,
      accept: '*/*',
    },
    body: JSON.stringify({ metadata, mode: 'FULL_ELIGIBILITY_CHECK' }),
  });
  return res;
}

section('2. loadCodeAssist → project_id / 订阅档位');
let base = forceProd ? BASE_PROD : BASE_DAILY;
let lcaRes = await loadCodeAssist(base);
log(`base=${base} 状态:`, lcaRes.status);
if (!lcaRes.ok && !forceProd) {
  log('daily 非 2xx，回退 prod 再试…');
  base = BASE_PROD;
  lcaRes = await loadCodeAssist(base);
  log(`base=${base} 状态:`, lcaRes.status);
}
let projectId;
if (lcaRes.ok) {
  const lca = await lcaRes.json();
  projectId =
    (typeof lca.cloudaicompanionProject === 'string' && lca.cloudaicompanionProject) ||
    lca.project?.id ||
    (typeof lca.project === 'string' ? lca.project : undefined);
  log('project_id:', projectId ?? '(未直接返回，可能需 onboardUser)');
  log('paidTier:', JSON.stringify(lca.paidTier ?? lca.currentTier ?? null));
  log('allowedTiers:', JSON.stringify((lca.allowedTiers ?? []).map((t) => t.id)));
  log('顶层字段:', Object.keys(lca).join(', '));
} else {
  log('loadCodeAssist 失败:', (await lcaRes.text()).slice(0, 400));
}

// ---------------------------------------------------------------- 2.5 fetchAvailableModels（cockpit per-model 额度真源）
section('2.5 fetchAvailableModels → per-model quota_info（cockpit 首选额度源）');
const famRes = await fetch(`${base}/v1internal:fetchAvailableModels`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': UA, // build_cloud_code_user_agent()：无 nodejs-client 后缀
    'accept-encoding': 'gzip',
  },
  body: JSON.stringify(projectId ? { project: projectId } : {}),
});
log('状态:', famRes.status);
const famText = await famRes.text();
if (famRes.ok) {
  let fam;
  try {
    fam = JSON.parse(famText);
    const models = fam.models ?? [];
    log('模型数:', models.length);
    for (const m of models.slice(0, 8)) {
      const q = m.quotaInfo ?? m.quota_info ?? {};
      log(`  · ${m.modelId ?? m.model ?? m.name ?? '?'}: remainingFraction=${q.remainingFraction ?? '-'} resetTime=${q.resetTime ?? '-'}`);
    }
    log('顶层字段:', Object.keys(fam).join(', '));
  } catch {
    log('响应非 JSON，前 400 字:', famText.slice(0, 400));
  }
} else {
  log('fetchAvailableModels 失败:', famText.slice(0, 400));
}

// ---------------------------------------------------------------- 3. retrieveUserQuotaSummary
section('3. retrieveUserQuotaSummary → 额度结构（weekly + 5h）');
const quotaRes = await fetch(`${base}/v1internal:retrieveUserQuotaSummary`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': UA,
  },
  body: JSON.stringify(projectId ? { project: projectId } : {}),
});
log('状态:', quotaRes.status);
const quotaText = await quotaRes.text();
if (quotaRes.ok) {
  let quota;
  try {
    quota = JSON.parse(quotaText);
  } catch {
    log('响应非 JSON，前 800 字:', quotaText.slice(0, 800));
    process.exit(0);
  }
  log('响应长度:', quotaText.length);
  log('顶层字段:', Object.keys(quota).join(', '));
  console.log('\n----- retrieveUserQuotaSummary 完整结构（token 已不含，可直接看）-----');
  console.log(JSON.stringify(quota, null, 2).slice(0, 6000));
} else {
  log('查额度失败:', quotaText.slice(0, 600));
}

section('done');
