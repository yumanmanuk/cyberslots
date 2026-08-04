/**
 * agyAccounts — Antigravity 账号导入池 + keyring 切号 + 额度查询（主进程）。
 *
 * 已实测坐实的机制（见 docs/antigravity-integration.md §3/§5/§6，
 * .dev/workdir/exp-crossaccount-evidence.md）：
 *  - 本程序只认【导入池】（userData/agy-accounts.json，明文 JSON）：
 *    用户在设置里从 cockpit 账号库（~/.antigravity_cockpit）显式勾选导入，
 *    未导入的账号不列出、不切号、不查额度（cockpit 库仅导入时只读扫描）。
 *    每个导入账号带 antigravity_enterprise client 的 refresh_token 副本。
 *  - 切号 = 用 enterprise client 现刷 refresh_token 得新 token → 构造
 *    keyring blob（明文 UTF-8 JSON）→ CredWrite 覆写条目 `gemini:antigravity`
 *    → 更新 ~/.gemini/google_accounts.json 的 active。agy 每次调用实时读，
 *    覆写即生效、无缓存。
 *  - 额度查询同链路（enterprise 现刷 → loadCodeAssist 取 project_id
 *    → retrieveUserQuotaSummary），与推理解耦、只扫导入池、不干扰当前会话。
 *
 * OAuth client secret 绝不硬编码：从环境变量或 gitignored 本地文件加载
 * （loadEnterpriseClient）。CredRead/CredWrite 经临时 .ps1 + powershell
 * P/Invoke（Windows only；agy 集成本就仅 Windows）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, net } from 'electron';

import type { AgyAccount, AgyAccountsSnapshot, AgyActiveQuota, AgyImportCandidate, AgyQuotaGroup, AgyQuotaInfo } from '@shared/types';
import { L } from '../../i18n';
import { compatAudit } from '../compatAudit';
import { log } from '../../log/logger';

const KEYRING_TARGET = 'gemini:antigravity';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CODE_ASSIST_BASES = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const FETCH_TIMEOUT_MS = 15_000;

/** 统一走 Chromium 网络栈（net.fetch，跟随系统代理）+ 超时中止。
 *  Node 原生 fetch 不走系统代理且无超时 — 在需代理访问 Google 的网络下
 *  会无限挂起，正是切号弹窗额度「永远加载中」的根因。 */
async function gFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await net.fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(L(`请求超时（${FETCH_TIMEOUT_MS / 1000}s，检查网络/代理）: ${new URL(url).host}`, `Request timed out (${FETCH_TIMEOUT_MS / 1000}s — check network/proxy): ${new URL(url).host}`));
    }
    throw e;
  }
}

function cockpitDir(): string {
  return join(homedir(), '.antigravity_cockpit');
}
function geminiDir(): string {
  return join(homedir(), '.gemini');
}

// --------------------------------------------------------- enterprise client

interface OAuthClient {
  id: string;
  secret: string;
}

/** 加载 antigravity_enterprise client 凭据（切号刷新用）。优先级：
 *  环境变量 AGY_ENTERPRISE_ID/SECRET → gitignored `.dev/agy-clients.json`。
 *  绝不把 secret 写进被跟踪源码。 */
function loadEnterpriseClient(): OAuthClient {
  const envId = process.env.AGY_ENTERPRISE_ID;
  const envSecret = process.env.AGY_ENTERPRISE_SECRET;
  if (envId && envSecret) return { id: envId, secret: envSecret };
  for (const candidate of [join(process.cwd(), '.dev', 'agy-clients.json'), join(geminiDir(), 'agy-clients.json')]) {
    try {
      const j = JSON.parse(readFileSync(candidate, 'utf8')) as { enterprise?: OAuthClient };
      if (j.enterprise?.id && j.enterprise.secret) return j.enterprise;
    } catch {
      /* try next */
    }
  }
  throw new Error(L(
    '缺少 antigravity_enterprise client 凭据：请设置环境变量 AGY_ENTERPRISE_ID/AGY_ENTERPRISE_SECRET，或提供 .dev/agy-clients.json。',
    'Missing antigravity_enterprise client credentials: set AGY_ENTERPRISE_ID/AGY_ENTERPRISE_SECRET env vars, or provide .dev/agy-clients.json.',
  ),
  );
}

// --------------------------------------------------------------- account pool

interface CockpitToken {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_timestamp?: number;
  oauth_client_key?: string;
}
interface CockpitAccountFile {
  email?: string;
  token?: CockpitToken;
}

function readCockpitAccountFile(id: string): CockpitAccountFile | undefined {
  try {
    return JSON.parse(readFileSync(join(cockpitDir(), 'accounts', `${id}.json`), 'utf8')) as CockpitAccountFile;
  } catch {
    return undefined;
  }
}

function readActiveEmail(): string | undefined {
  try {
    const ga = JSON.parse(readFileSync(join(geminiDir(), 'google_accounts.json'), 'utf8')) as { active?: string };
    return ga.active;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------- imported pool

interface ImportedAccount {
  id: string;
  email: string;
  name?: string;
  refreshToken: string;
  idToken?: string;
  importedAt: number;
}
interface ImportedStore {
  version: 1;
  accounts: ImportedAccount[];
}

function importedStorePath(): string {
  return join(app.getPath('userData'), 'agy-accounts.json');
}

function readImportedStore(): ImportedStore {
  try {
    const doc = JSON.parse(readFileSync(importedStorePath(), 'utf8')) as ImportedStore;
    if (Array.isArray(doc.accounts)) {
      return { version: 1, accounts: doc.accounts.filter((a) => a.id && a.email && a.refreshToken) };
    }
  } catch {
    /* 首次使用无文件 */
  }
  return { version: 1, accounts: [] };
}

function writeImportedStore(store: ImportedStore): void {
  writeFileSync(importedStorePath(), JSON.stringify(store, null, 2), 'utf8');
}

/** 列出导入池 + 当前活动账号（keyring/google_accounts 侧）。只读，零消耗。 */
export function listAgyAccounts(): AgyAccountsSnapshot {
  const snap: AgyAccountsSnapshot = { accounts: [] };
  try {
    snap.accounts = readImportedStore().accounts.map<AgyAccount>((a) => ({
      id: a.id,
      email: a.email,
      name: a.name,
      importedAt: a.importedAt,
    }));
    snap.active = readActiveEmail();
  } catch (err) {
    log.warn('engine.antigravity', 'read import pool failed', undefined, err);
    snap.error = `${L('读取导入池失败', 'Failed to read the import pool')}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return snap;
}

/** 扫描 cockpit 账号库生成导入候选（只读；仅供设置页导入弹层展示，
 *  这是本程序唯一会遍历 cockpit 全账号的入口）。已导入判定按 id **或邮箱**
 *  —— 文件导入的条目池内 id = 邮箱，只比 cockpit id 会漏判。 */
export function listAgyImportCandidates(): { candidates: AgyImportCandidate[]; error?: string } {
  try {
    const doc = JSON.parse(readFileSync(join(cockpitDir(), 'accounts.json'), 'utf8')) as {
      accounts?: Array<{ id?: string; email?: string; name?: string }>;
    };
    const store = readImportedStore();
    const importedIds = new Set(store.accounts.map((a) => a.id));
    const importedEmails = new Set(store.accounts.map((a) => a.email));
    const list = Array.isArray(doc.accounts) ? doc.accounts : [];
    const candidates = list
      .filter((a) => a.id && a.email)
      .map<AgyImportCandidate>((a) => ({
        id: a.id!,
        email: a.email!,
        name: a.name,
        imported: importedIds.has(a.id!) || importedEmails.has(a.email!),
        hasToken: !!readCockpitAccountFile(a.id!)?.token?.refresh_token,
      }));
    return { candidates };
  } catch (err) {
    return { candidates: [], error: `${L('读取 cockpit 账号库失败', 'Failed to read the cockpit account store')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 把选中的 cockpit 账号凭据拷入导入池（按 id 覆盖更新 — 重复导入
 *  = 刷新凭据副本）。失败的账号跳过并在快照 error 里汇总。 */
export function importAgyAccounts(ids: string[]): AgyAccountsSnapshot {
  const store = readImportedStore();
  const failed: string[] = [];
  for (const id of ids) {
    const f = readCockpitAccountFile(id);
    const rt = f?.token?.refresh_token;
    if (!f?.email || !rt) {
      failed.push(id);
      continue;
    }
    const entry: ImportedAccount = { id, email: f.email, refreshToken: rt, idToken: f.token?.id_token, importedAt: Date.now() };
    // 按 id 或邮箱去重：文件导入的同邮箱条目（id = 邮箱）也要命中，
    // 否则会按 cockpit id 追加出重复账号；命中时保留原池内 id。
    const i = store.accounts.findIndex((a) => a.id === id || a.email === f.email);
    const prev = i >= 0 ? store.accounts[i] : undefined;
    if (prev) store.accounts[i] = { ...entry, id: prev.id };
    else store.accounts.push(entry);
  }
  writeImportedStore(store);
  invalidateQuotaCaches();
  const snap = listAgyAccounts();
  if (failed.length) {
    log.warn('engine.antigravity', 'some accounts skipped on import (missing credentials)', { failed: failed.length, total: ids.length });
    snap.error = L(`${failed.length} 个账号缺少凭据，未导入`, `${failed.length} account(s) missing credentials — not imported`);
  }
  return snap;
}

/** 从导入池移除账号（只删本程序副本，不碰 cockpit / keyring）。 */
export function removeAgyAccount(id: string): AgyAccountsSnapshot {
  const store = readImportedStore();
  store.accounts = store.accounts.filter((a) => a.id !== id);
  writeImportedStore(store);
  invalidateQuotaCaches();
  return listAgyAccounts();
}

/** 从导出文件导入账号。支持两种形态：顶层数组 [{email, refresh_token}]
 *  （cockpit 生态的 accounts_export 格式，多余字段如 tags 忽略）或
 *  {accounts:[…]} 包装；字段名兼容 refresh_token/refreshToken、
 *  id_token/idToken。id_token 可缺（切号/查额度都用 refresh_token 现刷）。
 *  按 email 去重覆盖；新条目以 email 作为池内 id。 */
export function importAgyAccountsFromFile(filePath: string): AgyAccountsSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    const snap = listAgyAccounts();
    snap.error = `${L('文件读取/解析失败', 'Failed to read/parse the file')}: ${err instanceof Error ? err.message : String(err)}`;
    return snap;
  }
  const wrapped = (parsed as { accounts?: unknown }) ?? {};
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(wrapped.accounts) ? wrapped.accounts : null;
  if (!raw) {
    const snap = listAgyAccounts();
    snap.error = L('无法识别的文件格式：应为账号数组或 {accounts:[…]}', 'Unrecognized file format: expected an account array or {accounts:[…]}');
    return snap;
  }
  const store = readImportedStore();
  let skipped = 0;
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const email = typeof o.email === 'string' ? o.email.trim() : '';
    const rt =
      typeof o.refresh_token === 'string' && o.refresh_token
        ? o.refresh_token
        : typeof o.refreshToken === 'string'
          ? o.refreshToken
          : '';
    if (!email || !rt) {
      skipped++;
      continue;
    }
    const idToken = typeof o.id_token === 'string' ? o.id_token : typeof o.idToken === 'string' ? o.idToken : undefined;
    const i = store.accounts.findIndex((a) => a.email === email);
    // 已存在同邮箱条目（可能来自 cockpit 导入）时保留原池内 id，只刷新凭据。
    const prev = i >= 0 ? store.accounts[i] : undefined;
    const entry: ImportedAccount = { id: prev ? prev.id : email, email, refreshToken: rt, idToken, importedAt: Date.now() };
    if (i >= 0) store.accounts[i] = entry;
    else store.accounts.push(entry);
  }
  writeImportedStore(store);
  invalidateQuotaCaches();
  const snap = listAgyAccounts();
  if (skipped) snap.error = L(`${skipped} 条缺少 email/refresh_token，已跳过`, `${skipped} entries missing email/refresh_token — skipped`);
  return snap;
}

function invalidateQuotaCaches(): void {
  quotaCache = undefined;
  activeCache = undefined;
}

// --------------------------------------------------------------- token refresh

interface RefreshedToken {
  access_token: string;
  id_token?: string;
  expires_in: number;
}

async function refreshWithEnterprise(refreshToken: string): Promise<RefreshedToken> {
  const client = loadEnterpriseClient();
  const form = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await gFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${L('刷新失败', 'Token refresh failed')} (${res.status}): ${txt.slice(0, 200)}`);
  }
  const t = (await res.json()) as { access_token?: string; id_token?: string; expires_in?: number };
  if (!t.access_token) throw new Error(L('刷新响应无 access_token', 'Refresh response has no access_token'));
  return { access_token: t.access_token, id_token: t.id_token, expires_in: t.expires_in ?? 3599 };
}

/** 构造 agy keyring blob（结构见 §3.2）：token/id_token/auth_method 三顶层字段。 */
function buildKeyringBlob(refreshToken: string, r: RefreshedToken, fallbackIdToken?: string): string {
  const blob = {
    token: {
      access_token: r.access_token,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(Date.now() + r.expires_in * 1000).toISOString(),
    },
    id_token: r.id_token || fallbackIdToken || '',
    auth_method: 'consumer',
  };
  return JSON.stringify(blob);
}

// ----------------------------------------------------------------- PowerShell

interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 写临时 .ps1 + 运行 powershell -File（Node 直接 spawn，无 shell 插值）。 */
function runPowerShellScript(script: string, extraFiles: Record<string, string> = {}): Promise<PsResult> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-keyring-'));
    const scriptPath = join(dir, 'op.ps1');
    try {
      for (const [name, content] of Object.entries(extraFiles)) {
        writeFileSync(join(dir, name), content, { encoding: 'utf8' });
      }
      // 用 __DIR__ 占位让脚本引用同目录的附带文件。
      writeFileSync(scriptPath, script.replace(/__DIR__/g, dir.replace(/\\/g, '\\\\')), { encoding: 'utf8' });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    const done = (code: number): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve({ code, stdout, stderr });
    };
    child.on('error', (e) => {
      stderr += String(e);
      done(-1);
    });
    child.on('close', (code) => done(code ?? -1));
  });
}

const CRED_STRUCT = `
$sig = @"
using System;
using System.Runtime.InteropServices;
public class AgyCred {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
}
"@
Add-Type -TypeDefinition $sig
`;

/** CredWrite keyring 条目 gemini:antigravity（blob 从临时文件读，UTF-8 无 BOM）。 */
async function credWriteBlob(blobJson: string): Promise<void> {
  const script = `${CRED_STRUCT}
$blob = [IO.File]::ReadAllText((Join-Path '__DIR__' 'blob.json'), (New-Object Text.UTF8Encoding($false)))
$bytes = [Text.Encoding]::UTF8.GetBytes($blob)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$cred = New-Object AgyCred+CREDENTIAL
$cred.Type = 1; $cred.TargetName = '${KEYRING_TARGET}'; $cred.CredentialBlobSize = $bytes.Length
$cred.CredentialBlob = $ptr; $cred.Persist = 2; $cred.UserName = 'antigravity'
$ok = [AgyCred]::CredWrite([ref]$cred, 0)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if (-not $ok) { Write-Error ("CredWrite failed err=" + $err); exit 1 }
Write-Output 'OK'
`;
  const res = await runPowerShellScript(script, { 'blob.json': blobJson });
  if (res.code !== 0) throw new Error(`${L('keyring 写入失败', 'keyring write failed')}: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
}

function updateGoogleAccountsActive(email: string): void {
  const path = join(geminiDir(), 'google_accounts.json');
  let doc: { active?: string; old?: string[] } = {};
  try {
    doc = JSON.parse(readFileSync(path, 'utf8')) as typeof doc;
  } catch {
    /* new file */
  }
  const old = new Set(doc.old ?? []);
  if (doc.active && doc.active !== email) old.add(doc.active);
  old.delete(email);
  doc.active = email;
  doc.old = [...old];
  try {
    writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
  } catch {
    /* 非致命：keyring 已切，active 指针只是辅助显示 */
  }
}

/**
 * 切换到导入池里的指定账号：现刷 → 构造 blob → CredWrite → 更新 active。
 * agy 下一次调用即以新账号执行（实时读 keyring，无需重启进程）。
 * 未导入的账号一律拒切 — 本程序只能使用用户显式导入的账号。
 */
export async function switchAgyAccount(accountId: string): Promise<{ email: string }> {
  const acct = readImportedStore().accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error(L(`账号 ${accountId} 不在导入池中 — 请先在「设置 → 模型 → Antigravity 账号」导入`, `Account ${accountId} is not in the import pool — import it first under Settings → Engines → Antigravity accounts`));
  const refreshed = await refreshWithEnterprise(acct.refreshToken);
  const blob = buildKeyringBlob(acct.refreshToken, refreshed, acct.idToken);
  await credWriteBlob(blob);
  updateGoogleAccountsActive(acct.email);
  log.info('engine.antigravity', 'account switched (keyring rewritten)', { accountId, email: acct.email });
  return { email: acct.email };
}

// ------------------------------------------------------------------- quota

interface QuotaCache {
  data: AgyQuotaInfo[];
  ts: number;
}
let quotaCache: QuotaCache | undefined;
let quotaInflight: Promise<AgyQuotaInfo[]> | undefined;
const QUOTA_TTL_MS = 60_000;

/** 查询账号额度（扫导入池）。带 TTL 缓存 + in-flight 去重。
 *  best-effort：单账号失败只标该账号 error。 */
export async function queryAgyQuota(force = false): Promise<AgyQuotaInfo[]> {
  if (!force && quotaCache && Date.now() - quotaCache.ts < QUOTA_TTL_MS) return quotaCache.data;
  if (quotaInflight) return quotaInflight;
  quotaInflight = (async () => {
    try {
      const snap = listAgyAccounts();
      // 并行查（每账号独立 best-effort）— 串行扫描会被第一个慢请求拖死整批。
      const results = await Promise.all(snap.accounts.map((a) => queryOneAccount(a)));
      quotaCache = { data: results, ts: Date.now() };
      return results;
    } finally {
      // 无论成败失败都释放 in-flight — 否则一次异常会让后续所有查询永久复用卡死的 Promise。
      quotaInflight = undefined;
    }
  })();
  return quotaInflight;
}

async function queryOneAccount(account: AgyAccount): Promise<AgyQuotaInfo> {
  const info: AgyQuotaInfo = { email: account.email, accountId: account.id, ok: false, groups: [], queriedAt: Date.now() };
  try {
    const rt = readImportedStore().accounts.find((a) => a.id === account.id)?.refreshToken;
    if (!rt) throw new Error(L('账号不在导入池中', 'Account is not in the import pool'));
    const refreshed = await refreshWithEnterprise(rt);
    const { base, projectId } = await loadCodeAssist(refreshed.access_token);
    info.groups = await retrieveQuotaSummary(base, refreshed.access_token, projectId);
    info.ok = true;
  } catch (err) {
    log.warn('engine.antigravity', 'account quota query failed', { email: account.email }, err);
    info.error = err instanceof Error ? err.message : String(err);
  }
  return info;
}

let activeCache: { data: AgyActiveQuota; ts: number } | undefined;
let activeInflight: Promise<AgyActiveQuota> | undefined;

/** 只查【当前活动账号】的额度（用量小窗/大窗常显）。仅 1 次网络往返，
 *  与 queryAgyQuota（扫导入池）解耦。同样 60s TTL 缓存 + in-flight 去重。 */
export async function queryActiveAgyQuota(force = false): Promise<AgyActiveQuota> {
  if (!force && activeCache && Date.now() - activeCache.ts < QUOTA_TTL_MS) return activeCache.data;
  if (activeInflight) return activeInflight;
  activeInflight = (async () => {
    const data: AgyActiveQuota = { ok: false, groups: [], queriedAt: Date.now() };
    try {
      const snap = listAgyAccounts();
      data.email = snap.active;
      // 活动邮箱 → 导入池对应账号（拿 refresh_token）；未导入则无法代查。
      const acct = snap.accounts.find((a) => snap.active && a.email === snap.active);
      if (!acct) throw new Error(L('当前活动账号未导入本程序', 'The currently active account is not imported into this app'));
      data.email = acct.email;
      const one = await queryOneAccount(acct);
      data.ok = one.ok;
      data.groups = one.groups;
      data.error = one.error;
    } catch (err) {
      data.error = err instanceof Error ? err.message : String(err);
    } finally {
      activeInflight = undefined;
    }
    activeCache = { data, ts: Date.now() };
    return data;
  })();
  return activeInflight;
}

const UA = 'antigravity/1.1.8 windows/amd64';

async function loadCodeAssist(accessToken: string): Promise<{ base: string; projectId?: string }> {
  let lastErr = '';
  for (const base of CODE_ASSIST_BASES) {
    try {
      const res = await gFetch(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ metadata: { pluginType: 'GEMINI' } }),
      });
      if (res.ok) {
        const j = (await res.json()) as { cloudaicompanionProject?: string };
        return { base, projectId: j.cloudaicompanionProject };
      }
      lastErr = `${res.status} @ ${base}`;
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`${L('loadCodeAssist 失败', 'loadCodeAssist failed')}: ${lastErr}`);
}

/** retrieveUserQuotaSummary → 归一化为「分组周额度」。字段宽松解析
 *  （不同后端版本形态可能不同；解析不到则返回空组不报错）。 */
async function retrieveQuotaSummary(base: string, accessToken: string, projectId?: string): Promise<AgyQuotaGroup[]> {
  const res = await gFetch(`${base}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
  if (!res.ok) throw new Error(`retrieveUserQuotaSummary ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const groups = parseQuotaGroups(j);
  // 成功响应却解析出 0 组 = 字段命名对不上（parseQuotaGroups 的候选名从未被
  // 真实成功响应验证过）——把原始报文留档供校准，避免静默丢数据。
  if (groups.length === 0) {
    compatAudit.record('antigravity', 'parse-error', 'retrieveUserQuotaSummary 无可解析额度分组', j);
  }
  // 产品决策：Gemini 组额度所有 UI 一律不展示。主路径已在 parseQuotaGroups
  // 按组名跳过；此处再按 group/models 给兜底路径（未知后端形态）再滤一道，
  // 覆盖悬浮小窗/用量大窗/切号弹窗/设置页账号卡片全部展示位。
  // 时间窗顺序与 kimi/minimax 余量行对齐：5小时在前、7天在后（后端 weekly 桶在前）。
  const winRank = (g: AgyQuotaGroup): number => (g.group === '5小时' ? 0 : g.group === '7天' ? 1 : 2);
  return groups
    .filter((g) => !`${g.group} ${(g.models ?? []).join(' ')}`.toLowerCase().includes('gemini'))
    .sort((a, b) => winRank(a) - winRank(b));
}

/** 从 quota summary 响应里提取分组额度。实测结构（2026-07 留档校准，
 *  见 logs/compat-audit.jsonl）：
 *  { groups: [ { displayName, description, buckets: [
 *      { bucketId, displayName, window: 'weekly'|'5h', resetTime: ISO8601,
 *        remainingFraction: 0–1 } ] } ] }
 *  只保留 Claude 组（Gemini 组产品决策不展示），每个时间窗各出一行；
 *  group 字段直接用时间窗标签（5小时/7天）— 分组名不展示（用户只用 claude，
 *  「Claude and GPT」字样在窄卡片里只会被截断）；解析不出时降级走旧的宽松字段猜测。 */
function parseQuotaGroups(j: Record<string, unknown>): AgyQuotaGroup[] {
  const groups: AgyQuotaGroup[] = [];
  if (Array.isArray(j.groups)) {
    for (const g of j.groups as Array<Record<string, unknown>>) {
      const gName = str(g.displayName) ?? 'default';
      // Gemini 组在解析层直接跳过（名字已不进 group 字段，后置过滤无法再靠组名识别）。
      if (/gemini/i.test(gName)) continue;
      // 组内模型清单藏在 description 尾部：“Models within this group: A, B”
      const modelsText = str(g.description)?.match(/Models within this group:\s*(.+)$/i)?.[1];
      const models = modelsText ? modelsText.split(/,\s*/) : undefined;
      const buckets = Array.isArray(g.buckets) ? (g.buckets as Array<Record<string, unknown>>) : [];
      for (const b of buckets) {
        const remaining = num(b.remainingFraction);
        const resetTime = str(b.resetTime);
        const resetAt = resetTime ? Date.parse(resetTime) : NaN;
        if (remaining == null && !Number.isFinite(resetAt)) continue;
        const win = str(b.window);
        // 与 kimi/minimax 余量行的时间窗措辞对齐：weekly → 7天。
        const label = win === 'weekly' ? '7天' : win === '5h' ? '5小时' : (str(b.displayName) ?? win ?? '');
        groups.push({
          group: label,
          utilization: remaining != null ? (1 - remaining) * 100 : 0,
          resetsInSeconds: Number.isFinite(resetAt) ? Math.max(0, Math.round((resetAt - Date.now()) / 1000)) : undefined,
          models,
        });
      }
    }
    if (groups.length > 0) return groups;
  }
  // 兑底：未知后端形态时的宽松字段猜测（均失败则由调用方留档原始报文）。
  const buckets = (j.quotaBuckets ?? j.buckets ?? j.quotas ?? j.modelQuotas) as unknown;
  if (Array.isArray(buckets)) {
    for (const b of buckets as Array<Record<string, unknown>>) {
      const name = str(b.groupName) ?? str(b.name) ?? str(b.group) ?? str(b.modelGroup) ?? 'default';
      const used = num(b.utilization) ?? num(b.percentUsed) ?? num(b.used);
      const remaining = num(b.remainingPercent) ?? num(b.percentRemaining);
      const utilization = used ?? (remaining != null ? 100 - remaining : undefined);
      const resetSec = num(b.resetsInSeconds) ?? num(b.secondsUntilReset) ?? num(b.resetSeconds);
      const models = Array.isArray(b.models) ? (b.models as unknown[]).map(String) : undefined;
      if (utilization != null || resetSec != null) {
        groups.push({ group: name, utilization: utilization ?? 0, resetsInSeconds: resetSec, models });
      }
    }
  }
  return groups;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** keyring 是否存在有效的 antigravity 凭据条目（引擎可用性探测用）。 */
export function hasAgyKeyring(): boolean {
  // google_accounts.json 有 active（已在外部认证过）或导入池非空即可用。
  return !!readActiveEmail() || readImportedStore().accounts.length > 0;
}
