// agyClients.mjs — Antigravity OAuth client 凭据加载器（不含任何机密，可安全提交）。
//
// 机密来源优先级：
//   1) 环境变量：AGY_ENTERPRISE_ID / AGY_ENTERPRISE_SECRET / AGY_GEMINICLI_ID / AGY_GEMINICLI_SECRET
//   2) 本地 gitignored 文件：<repoRoot>/.dev/agy-clients.json（.dev/ 已被 .gitignore 整体忽略）
// 两者都缺失时抛错，明确提示如何配置——绝不把机密写进被 git 跟踪的源码。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..'); // scripts/ 的上一级 = 仓库根
const LOCAL_FILE = join(REPO_ROOT, '.dev', 'agy-clients.json');

let fileCache;
function fromFile() {
  if (fileCache !== undefined) return fileCache;
  try { fileCache = JSON.parse(readFileSync(LOCAL_FILE, 'utf8')); }
  catch { fileCache = null; }
  return fileCache;
}

function pick(envId, envSecret, fileKey) {
  const f = fromFile();
  const id = process.env[envId] || f?.[fileKey]?.id;
  const secret = process.env[envSecret] || f?.[fileKey]?.secret;
  if (!id || !secret) {
    throw new Error(
      `[agyClients] 缺少 ${fileKey} 凭据。请设置环境变量 ${envId}/${envSecret}，` +
      `或在 ${LOCAL_FILE} 提供 { "${fileKey}": { "id", "secret" } }（该文件已 gitignore）。`
    );
  }
  return { id, secret };
}

/** antigravity_enterprise client（agy keyring 与 cockpit 同用）。 */
export const getEnterpriseClient = () => pick('AGY_ENTERPRISE_ID', 'AGY_ENTERPRISE_SECRET', 'enterprise');
/** gemini-cli 公共 client（仅陈旧 oauth_creds.json 历史凭据用）。 */
export const getGeminiCliClient = () => pick('AGY_GEMINICLI_ID', 'AGY_GEMINICLI_SECRET', 'geminicli');
