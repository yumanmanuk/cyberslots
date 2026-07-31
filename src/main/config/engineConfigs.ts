/**
 * engineConfigs — read-only view of the user's own CLI configs
 * (~/.kimi-code/config.toml, ~/.codex/config.toml) plus the routing
 * upstream resolver. 本程序永不写这两个文件；路由开启时也只是
 * 进程级注入（codex 用 `-c` 覆盖、kimi 用运行时镜像 home）。
 */

import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type {
  CodexCatalogModel,
  CodexConfigProvider,
  CodexConfigSnapshot,
  EngineConfigsSnapshot,
  KimiConfigModel,
  KimiConfigProvider,
  KimiConfigSnapshot,
} from '@shared/types';
import { readOpencodeSnapshot } from '../engine/opencode/resolveOpencode';
import { L } from '../i18n';
import { readOmpSnapshot } from '../engine/omp/resolveOmp';
import { readAntigravitySnapshot } from '../engine/antigravity/resolveAntigravity';
import { readClaudeSnapshot } from '../engine/claude/resolveClaude';
import { detectKap } from '../engine/kimi/KapServerHost';
import { codexSpawnEnv, resolveCodexCli } from '../engine/codex/resolveCodex';
import { kimiSpawnEnv, resolveKimiCli } from '../engine/kimi/resolveKimi';

type Json = Record<string, unknown>;

// ------------------------------------------------------- version probes
// kimi/codex 快照历来只读配置文件（不 spawn CLI）故无版本号；这里补上：
// 快路径读 npm 全局包 package.json（零 spawn、瞬时），兜底 `--version`
// 探测（PATH 安装等场景）。缓存策略同 resolveClaude：成功进程级缓存，
// 失败短 TTL（应用先启动、CLI 后安装无需重启即可检出）。

const versionCache = new Map<string, { value?: string; failedAt?: number }>();
const VERSION_FAIL_TTL = 30_000;

/** npm 全局包 package.json 的版本快路径；不存在/解不动返回 undefined。 */
function npmPkgVersion(...segments: string[]): string | undefined {
  if (!process.env.APPDATA) return undefined;
  try {
    const p = join(process.env.APPDATA, 'npm', 'node_modules', ...segments, 'package.json');
    if (!existsSync(p)) return undefined;
    const v = (JSON.parse(readFileSync(p, 'utf8')) as Json).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function probeCliVersion(key: 'codex' | 'kimi'): string | undefined {
  const cached = versionCache.get(key);
  if (cached?.value) return cached.value;
  if (cached?.failedAt && Date.now() - cached.failedAt < VERSION_FAIL_TTL) return undefined;
  const pkg = key === 'codex' ? npmPkgVersion('@openai', 'codex') : npmPkgVersion('@moonshot-ai', 'kimi-code');
  if (pkg) {
    versionCache.set(key, { value: pkg });
    return pkg;
  }
  try {
    const spec = key === 'codex' ? resolveCodexCli(['--version']) : resolveKimiCli(['--version']);
    const env = key === 'codex' ? codexSpawnEnv((spec as { managedRoot?: string }).managedRoot) : kimiSpawnEnv();
    const res = spawnSync(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env,
    });
    // 输出形如 `codex-cli 0.48.0` / `kimi-code 0.30.1` — 抠第一个版本号。
    const m = (res.stdout ?? '').trim().match(/(\d+\.\d+\.\d+)/);
    if (m) {
      versionCache.set(key, { value: m[1] });
      return m[1];
    }
  } catch {
    /* 探测失败 — 落失败缓存 */
  }
  versionCache.set(key, { failedAt: Date.now() });
  return undefined;
}

/** 读 TOML 并容忍 UTF-8 BOM（Windows 编辑器常见）。 */
function parseTomlFile(path: string): Json {
  return tomlParse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Json;
}

export function kimiHomeDir(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
}

export function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

// ------------------------------------------------------------- snapshots

export function readKimiConfig(): KimiConfigSnapshot {
  const home = kimiHomeDir();
  const configPath = join(home, 'config.toml');
  const snap: KimiConfigSnapshot = { home, configPath, exists: existsSync(configPath), providers: [] };
  snap.version = probeCliVersion('kimi');
  // KAP 通道静态探测（同步、不 spawn）— 设置页/启动日志展示用。
  snap.kap = detectKap(home);
  if (!snap.exists) return snap;
  try {
    const doc = parseTomlFile(configPath);
    snap.defaultModel = str(doc.default_model);
    const providers = (doc.providers ?? {}) as Record<string, Json>;
    const models = (doc.models ?? {}) as Record<string, Json>;
    for (const [id, p] of Object.entries(providers)) {
      const entry: KimiConfigProvider = {
        id,
        type: str(p.type) ?? 'kimi',
        baseUrl: str(p.base_url) ?? '',
        hasKey: !!str(p.api_key),
        models: [],
      };
      for (const [alias, m] of Object.entries(models)) {
        if (str(m.provider) === id) {
          entry.models.push({
            alias,
            model: str(m.model) ?? alias,
            maxContextSize: num(m.max_context_size),
            ...kimiModelEfforts(m),
          });
        }
      }
      snap.providers.push(entry);
    }
  } catch (err) {
    snap.error = L('配置解析失败', 'Config parse failed') + `: ${err instanceof Error ? err.message : String(err)}`;
  }
  return snap;
}

/** 合成 kimi 模型的思考档位面板值域，对齐 CLI 0.30 buildThinkingOption：
 *  值域 = support_efforts，非 always_thinking 模型前置 off 行；无 capabilities
 *  thinking 声明 = 不支持思考 → 无档位；overrides 子块优先（托管刷新仅保留
 *  overrides，本体值会被服务端重写）。 */
function kimiModelEfforts(m: Json): Pick<KimiConfigModel, 'efforts' | 'defaultEffort'> {
  const o = (m.overrides ?? {}) as Json;
  const caps = (Array.isArray(m.capabilities) ? m.capabilities : []).map((c) => String(c).toLowerCase());
  const always = caps.includes('always_thinking');
  if (!always && !caps.includes('thinking')) return {};
  const declared = (Array.isArray(o.support_efforts) ? o.support_efforts : Array.isArray(m.support_efforts) ? m.support_efforts : [])
    .map((e) => String(e))
    .filter(Boolean);
  const efforts = always ? declared : ['off', ...declared];
  if (efforts.length < 2) return {}; // 无可选档（纯 on/off 布尔模型也不值得出控件）
  const rawDefault = str(o.default_effort) ?? str(m.default_effort);
  const defaultEffort = rawDefault && declared.includes(rawDefault) ? rawDefault : declared[Math.floor(declared.length / 2)];
  return { efforts, defaultEffort };
}

export function readCodexConfig(): CodexConfigSnapshot {
  const home = codexHomeDir();
  const configPath = join(home, 'config.toml');
  const snap: CodexConfigSnapshot = {
    home,
    configPath,
    exists: existsSync(configPath),
    authMode: 'none',
    providers: [],
  };
  snap.version = probeCliVersion('codex');
  // auth.json（ChatGPT 登录 / API key）与 config.toml 相互独立。
  try {
    const authPath = join(home, 'auth.json');
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Json;
      const declared = str(auth.auth_mode);
      if (declared === 'chatgpt') snap.authMode = 'chatgpt';
      else if (declared === 'apikey') snap.authMode = 'apikey';
      else if (auth.tokens || auth.token) snap.authMode = 'chatgpt';
      else if (auth.OPENAI_API_KEY) snap.authMode = 'apikey';
    }
  } catch {
    /* auth.json unreadable — leave 'none' */
  }
  if (!snap.exists) return snap;
  try {
    const doc = parseTomlFile(configPath);
    snap.model = str(doc.model);
    snap.reasoningEffort = str(doc.model_reasoning_effort);
    snap.activeProvider = str(doc.model_provider);
    const catalogRef = str(doc.model_catalog_json);
    if (catalogRef) snap.catalogModels = readCodexCatalog(home, catalogRef);
    const providers = (doc.model_providers ?? {}) as Record<string, Json>;
    for (const [id, p] of Object.entries(providers)) {
      const envKey = str(p.env_key);
      const entry: CodexConfigProvider = {
        id,
        name: str(p.name),
        baseUrl: str(p.base_url) ?? '',
        wireApi: str(p.wire_api) ?? 'responses',
        envKey,
        hasKey: envKey ? !!process.env[envKey] : true, // 无 env_key = 端点不要求 key
      };
      snap.providers.push(entry);
    }
  } catch (err) {
    snap.error = L('配置解析失败', 'Config parse failed') + `: ${err instanceof Error ? err.message : String(err)}`;
  }
  return snap;
}

/** 解析 codex model_catalog_json（cc-switch 等工具生成）：目录里的 slug
 *  就是 codex `model` 参数值，附带上下文窗口/输入模态/思考深度档位。
 *  相对路径相对 CODEX_HOME 解析；解析失败返回 undefined（不阻断快照）。 */
function readCodexCatalog(home: string, ref: string): CodexCatalogModel[] | undefined {
  try {
    const path = isAbsolute(ref) ? ref : join(home, ref);
    if (!existsSync(path)) return undefined;
    const doc = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Json;
    const models = Array.isArray(doc.models) ? (doc.models as Json[]) : [];
    const out: CodexCatalogModel[] = [];
    for (const m of models) {
      const slug = str(m.slug);
      if (!slug || str(m.visibility) === 'hidden') continue;
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as Json[]).map((l) => str(l.effort)).filter((e): e is string => !!e)
        : [];
      out.push({
        slug,
        displayName: str(m.display_name),
        contextWindow: num(m.context_window),
        inputModalities: Array.isArray(m.input_modalities)
          ? (m.input_modalities as unknown[]).map(String)
          : undefined,
        efforts: levels.length ? levels : undefined,
        defaultEffort: str(m.default_reasoning_level),
      });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

export function readEngineConfigs(opts?: { claudeCliPath?: string }): EngineConfigsSnapshot {
  const kimi = readKimiConfig();
  const codex = readCodexConfig();
  return {
    kimi,
    codex,
    opencode: readOpencodeSnapshot(),
    omp: readOmpSnapshot(),
    antigravity: readAntigravitySnapshot(),
    claude: readClaudeSnapshot(opts?.claudeCliPath),
    routeSupport: {
      kimi: kimiRouteSupport(kimi),
      codex: codexRouteSupport(codex, kimi),
    },
  };
}

// -------------------------------------------------------- route planning

/** 转换/直通槽位上游 — 喂给内置 server 的 env（key 只经内存与 env）。 */
export interface RouteUpstreams {
  /** chat-completions 上游（转换/透传槽，KIMI_* env）。 */
  chat?: { baseUrl: string; apiKey: string };
  /** responses 上游（直通槽，MINIMAX_* env）。 */
  responses?: { baseUrl: string; apiKey: string };
}

const CHAT_TYPES = new Set(['kimi', 'openai']);

function kimiRouteSupport(kimi: KimiConfigSnapshot): { ok: boolean; reason?: string } {
  if (!kimi.exists) return { ok: false, reason: L(`未找到 Kimi Code 配置（${kimi.configPath}）`, `Kimi Code config not found (${kimi.configPath})`) };
  if (kimi.error) return { ok: false, reason: kimi.error };
  const chat = kimi.providers.find((p) => CHAT_TYPES.has(p.type) && p.baseUrl);
  if (!chat) return { ok: false, reason: L('配置中没有 chat-completions 协议端点，无需/无法路由', 'No chat-completions endpoint in config — routing unnecessary/unavailable') };
  return { ok: true };
}

function codexRouteSupport(codex: CodexConfigSnapshot, kimi: KimiConfigSnapshot): { ok: boolean; reason?: string } {
  // 上游优先取 codex 自己配置的自定义端点；否则回落到 kimi 配置的端点
  // （即「用 kimi/minimax 的号跑 codex」——本程序的初始核心场景）。
  const own = codexActiveCustomProvider(codex);
  if (own) {
    if (own.envKey && !process.env[own.envKey]) {
      return { ok: false, reason: L(`端点 ${own.id} 的密钥环境变量 ${own.envKey} 未设置`, `API key env var ${own.envKey} for endpoint ${own.id} is not set`) };
    }
    return { ok: true };
  }
  const fromKimi = kimi.providers.find((p) => p.baseUrl && (CHAT_TYPES.has(p.type) || p.type === 'openai_responses'));
  if (fromKimi) return { ok: true };
  return { ok: false, reason: L('Codex 配置无自定义端点，Kimi 配置也无可借用端点', 'No custom endpoint in the Codex config, and none borrowable from the Kimi config') };
}

function codexActiveCustomProvider(codex: CodexConfigSnapshot): CodexConfigProvider | undefined {
  if (!codex.activeProvider) return undefined;
  return codex.providers.find((p) => p.id === codex.activeProvider && p.baseUrl);
}

/** Kimi 路由上游：kimi 自己配置里的 chat / responses 端点各取第一个。 */
export function resolveKimiRouteUpstreams(kimi: KimiConfigSnapshot): RouteUpstreams {
  const raw = kimi.exists ? parseTomlFile(kimi.configPath) : {};
  const providers = (raw.providers ?? {}) as Record<string, Json>;
  const ups: RouteUpstreams = {};
  for (const [, p] of Object.entries(providers)) {
    const type = str(p.type) ?? 'kimi';
    const baseUrl = str(p.base_url) ?? '';
    const apiKey = str(p.api_key) ?? '';
    if (!baseUrl) continue;
    if (!ups.chat && CHAT_TYPES.has(type)) ups.chat = { baseUrl, apiKey };
    if (!ups.responses && type === 'openai_responses') ups.responses = { baseUrl, apiKey };
  }
  return ups;
}

/** Codex 路由上游：codex 自定义端点优先，否则借用 kimi 配置端点。 */
export function resolveCodexRouteUpstreams(codex: CodexConfigSnapshot, kimi: KimiConfigSnapshot): RouteUpstreams {
  const own = codexActiveCustomProvider(codex);
  if (own) {
    const apiKey = own.envKey ? (process.env[own.envKey] ?? '') : '';
    // codex 老配置里 wire_api 可能是 chat（该协议已从 codex 删除 → 正是需要路由的场景）
    return own.wireApi === 'responses'
      ? { responses: { baseUrl: own.baseUrl, apiKey } }
      : { chat: { baseUrl: own.baseUrl, apiKey } };
  }
  return resolveKimiRouteUpstreams(kimi);
}

// ------------------------------------------------- kimi route mirror home

/**
 * Kimi 路由镜像 home：把用户 kimi 配置深拷贝到 app 数据目录，仅将
 * chat 端点的 base_url 改写为本地 chat 前端；用户原文件保持不动。
 * KIMI_CODE_HOME 指向镜像目录只影响本程序 spawn 的 kimi 进程。
 */
export function buildKimiRouteMirror(userDataDir: string, kimi: KimiConfigSnapshot, port: number): string {
  const home = join(userDataDir, 'kimi-route-home');
  mkdirSync(home, { recursive: true });
  const doc = parseTomlFile(kimi.configPath);
  const providers = (doc.providers ?? {}) as Record<string, Json>;
  for (const [, p] of Object.entries(providers)) {
    const type = str(p.type) ?? 'kimi';
    if (CHAT_TYPES.has(type) && str(p.base_url)) {
      p.base_url = `http://127.0.0.1:${port}/v1`;
    }
  }
  const header =
    '# CyberSlots 路由镜像 — 由用户 kimi 配置生成，仅 base_url 指向本地路由 server。\n' +
    `# 源文件（只读，未被修改）：${kimi.configPath}\n`;
  writeFileSync(join(home, 'config.toml'), header + tomlStringify(doc) + '\n', 'utf8');
  return home;
}

/** Codex 路由 = 纯命令行 `-c` 覆盖（不写任何文件，含用户的 ~/.codex）。 */
export function codexRouteOverrideArgs(port: number): string[] {
  return [
    '-c',
    'model_provider=cyberslots',
    '-c',
    'model_providers.cyberslots.name=CyberSlots-Router',
    '-c',
    `model_providers.cyberslots.base_url=http://127.0.0.1:${port}/v1`,
    '-c',
    'model_providers.cyberslots.wire_api=responses',
    '-c',
    'model_providers.cyberslots.requires_openai_auth=false',
  ];
}

// ---------------------------------------------------------------- utils

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
