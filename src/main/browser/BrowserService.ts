/**
 * BrowserService —— browser use 工具服务层（方案 Phase 1+2 的主体）。
 *
 * 职责：
 * 1. 经 BrowserHost 托管独立 profile 的 Chrome，playwright-core 走 CDP 驱动；
 * 2. 七个工具原语（policy.BROWSER_TOOLS）的执行 + 上下文预算硬约束；
 * 3. 客户端出口统一钩子：所有工具调用（含 MCP 转发来的）必经本类的
 *    分级闸口 —— read 放行 / navigate 白名单分级 / write 强制审批，不依赖
 *    引擎主动发起审批；
 * 4. 审批建模为 permission.request（origin:'browser'）复用 PermissionSheet
 *    通道，应答由 SessionManager 按 requestId 前缀 `browser:` 路由回本类；
 * 5. 以 stdio MCP server（零依赖脚本物化到 userData）形式向引擎暴露能力，
 *    工具调用经 loopback HTTP（Bearer token）回本类执行；
 * 6. 审计：只记摘要（动作类型/选择器或坐标/耗时/成功否）到 scope `browser`，
 *    截图、DOM、输入文本内容绝不落盘；compat-audit 通道不混用。
 *
 * 回滚：全部代码集中在 src/main/browser/，settings.browserUse=false 时
 * ensure() 直接抛错、引擎侧不注册 MCP —— 零侵入。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { app, type WebContents } from 'electron';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { McpServerStdio } from '@agentclientprotocol/sdk';

import { IPC } from '@shared/ipc';
import type {
  BrowserActionPreview,
  BrowserActionRecord,
  BrowserPanelState,
  BrowserServiceStatus,
  BrowserToolTier,
  EngineEventEnvelope,
  EngineId,
} from '@shared/types';

import type { SettingsStore } from '../config/settings';
import { log } from '../log/logger';
import { BrowserHost } from './BrowserHost';
import { MCP_SERVER_NAME, MCP_SERVER_SCRIPT } from './mcpServerScript';
import {
  BUDGET,
  BROWSER_TOOLS,
  decideGate,
  isSensitiveTarget,
  summarizeArgs,
  toolDef,
  truncate,
  type BrowserToolDef,
} from './policy';

const APPROVAL_TIMEOUT_MS = 120_000;
const ACTION_HISTORY_MAX = 100;
const CALL_BODY_MAX = 64 * 1024;
const TOOL_TIMEOUT_MS = 30_000;

/** MCP 工具调用结果（MCP content 数组形状，脚本侧原样透传）。 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

interface PendingApproval {
  sessionId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/** 审批卡外发知悉所需的会话信息（由 SessionManager 侧注入解析器）。 */
type SessionInfoResolver = (sessionId: string) => { engine: EngineId } | undefined;

export class BrowserService {
  private readonly host = new BrowserHost();
  private target: WebContents | undefined;
  private status: BrowserServiceStatus = 'off';
  private error: string | undefined;

  private pwBrowser: Browser | undefined;
  private page: Page | undefined;
  private pageUrl: string | undefined;
  private pageTitle: string | undefined;
  private screenshot: string | undefined;
  private actions: BrowserActionRecord[] = [];
  private seq = 0;

  private http: Server | undefined;
  private httpPort = 0;
  private readonly token = randomBytes(16).toString('hex');
  private readonly pending = new Map<string, PendingApproval>();
  private sessionInfo: SessionInfoResolver | undefined;

  constructor(private readonly settings: SettingsStore) {}

  attach(target: WebContents): void {
    this.target = target;
  }

  /** 注入会话信息解析器（审批卡「发往哪个模型端点」知悉）。 */
  bindSessionResolver(fn: SessionInfoResolver): void {
    this.sessionInfo = fn;
  }

  // ------------------------------------------------------------ 状态面板

  getState(): BrowserPanelState {
    return {
      status: this.status,
      pageTitle: this.pageTitle,
      pageUrl: this.pageUrl,
      screenshot: this.screenshot,
      actions: [...this.actions].reverse(),
      error: this.error,
    };
  }

  private pushState(): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.browserEvent, this.getState());
    }
  }

  // ------------------------------------------------------------ 生命周期

  /** 懒启动：Chrome + CDP 连接 + loopback HTTP 出口 + MCP 脚本物化（幂等）。 */
  async ensure(): Promise<BrowserPanelState> {
    if (!this.settings.get().browserUse) {
      throw new Error('browser use 未开启（settings.browserUse=false）。请在设置中打开后重试。');
    }
    if (this.status === 'running' && this.host.running) return this.getState();
    if (this.status === 'starting') {
      // 等待进行中的启动收敛（host 内部已去重，这里只做状态对齐）。
      await this.host.ensure().catch(() => undefined);
      return this.getState();
    }
    this.status = 'starting';
    this.error = undefined;
    this.pushState();
    try {
      const port = await this.host.ensure();
      await this.ensurePw(port);
      this.materializeMcpScript();
      await this.ensureHttp();
      this.status = 'running';
      log.info('browser', 'service ready', { debugPort: port, httpPort: this.httpPort });
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      log.error('browser', 'service start failed', {}, err);
    }
    this.pushState();
    return this.getState();
  }

  /** 关停（幂等）：拒掉挂起审批 → 断 CDP → 关 HTTP → 树杀 Chrome。 */
  async stop(): Promise<void> {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false);
      this.emitResolved(p.sessionId, id, undefined);
    }
    this.pending.clear();
    try {
      await this.pwBrowser?.close();
    } catch {
      /* 已断开 */
    }
    this.pwBrowser = undefined;
    this.page = undefined;
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    this.http = undefined;
    this.httpPort = 0;
    try {
      rmSync(join(this.mcpDir(), 'endpoint.json'), { force: true });
    } catch {
      /* 忽略 */
    }
    this.host.stop();
    this.status = 'off';
    this.pageUrl = undefined;
    this.pageTitle = undefined;
    log.info('browser', 'service stopped');
    this.pushState();
  }

  private async ensurePw(port: number): Promise<void> {
    if (this.pwBrowser?.isConnected()) return;
    this.pwBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    this.page = undefined;
  }

  private context(): BrowserContext {
    if (!this.pwBrowser) throw new Error('CDP 未连接');
    const ctx = this.pwBrowser.contexts()[0];
    if (!ctx) throw new Error('受管 Chrome 无可用上下文');
    return ctx;
  }

  /** 取当前活动页：优先复用已开页，没有则新建；固定视口兼作截图降分辨率。 */
  private async currentPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const pages = this.context().pages();
    this.page = pages.find((p) => !p.isClosed()) ?? (await this.context().newPage());
    await this.page.setViewportSize(BUDGET.viewport).catch(() => undefined);
    return this.page;
  }

  // ------------------------------------------------------------ MCP 注册面

  /** ACP（kimi/omp）newSession 的 mcpServers 规格（stdio，每会话携带 sessionId）。 */
  acpMcpServers(sessionId: string): McpServerStdio[] {
    return [
      {
        name: MCP_SERVER_NAME,
        command: process.execPath,
        args: [this.mcpScriptPath()],
        env: Object.entries(this.mcpEnv(sessionId)).map(([name, value]) => ({ name, value })),
      },
    ];
  }

  /** claude --mcp-config 配置文件路径：与用户 claudeMcpConfig 合并后按会话物化
   *  （per-session 文件：sessionId  env 随会话不同，共享文件会互相覆写）。 */
  claudeMcpConfigPath(sessionId: string): string {
    const ours = {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [this.mcpScriptPath()],
        env: this.mcpEnv(sessionId),
      },
    };
    let merged: Record<string, unknown> = {};
    const userPath = this.settings.get().claudeMcpConfig;
    if (userPath && existsSync(userPath)) {
      try {
        const parsed = JSON.parse(readFileSync(userPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
        merged = parsed.mcpServers ?? {};
      } catch (err) {
        log.warn('browser', '用户 claudeMcpConfig 解析失败，仅注册受管浏览器 MCP', { userPath }, err);
      }
    }
    const file = join(this.mcpDir(), `claude-mcp-${sessionId}.json`);
    writeFileSync(file, JSON.stringify({ mcpServers: { ...merged, ...ours } }, null, 2), 'utf8');
    return file;
  }

  /** codex `-c mcp_servers.*` 配置覆盖参数（TOML 值；spawn 走 argv 无 shell 转义）。 */
  codexConfigArgs(sessionId: string): string[] {
    const env = this.mcpEnv(sessionId);
    const envTable = Object.entries(env)
      .map(([k, v]) => `${k}=${tomlBasic(v)}`)
      .join(',');
    return [
      '-c',
      `mcp_servers.${MCP_SERVER_NAME.replaceAll('-', '_')}.command=${tomlBasic(process.execPath)}`,
      '-c',
      `mcp_servers.${MCP_SERVER_NAME.replaceAll('-', '_')}.args=[${tomlBasic(this.mcpScriptPath())}]`,
      '-c',
      `mcp_servers.${MCP_SERVER_NAME.replaceAll('-', '_')}.env={${envTable}}`,
    ];
  }

  /** 未接线的引擎面（opencode 共享 server / antigravity / kimi-KAP）—— 降级记录。 */
  logDegraded(engine: EngineId): void {
    log.info('browser', 'engine MCP surface not wired, browser tools degraded off for this engine', { engine });
  }

  private mcpEnv(sessionId: string): Record<string, string> {
    return {
      ELECTRON_RUN_AS_NODE: '1',
      CYBERSLOTS_MCP_MANIFEST: this.manifestJson(),
      // 端口不烘进 spec：会话创建时 HTTP 出口可能尚未拉起。脚本每次调用
      // 现读 endpoint.json（ensureHttp 落盘），杜绝「spec 端口=0」竞态。
      CYBERSLOTS_MCP_PORTFILE: join(this.mcpDir(), 'endpoint.json'),
      CYBERSLOTS_MCP_TOKEN: this.token,
      CYBERSLOTS_SESSION_ID: sessionId,
    };
  }

  private manifestJson(): string {
    return JSON.stringify(
      BROWSER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    );
  }

  private mcpDir(): string {
    const dir = join(app.getPath('userData'), 'browser-mcp');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private mcpScriptPath(): string {
    // spec 创建可能早于 ensure()（引擎会话建档即注册 MCP）——物化必须随取随做。
    this.materializeMcpScript();
    return join(this.mcpDir(), 'server.mjs');
  }

  /** 预热 MCP 出口（app 启动时调用，flag 开才生效）：只拉 HTTP 监听 +
   *  物化脚本，不碰 Chrome —— 保证引擎侧 tools/call 时 endpoint.json 已存在，
   *  Chrome 仍由首个工具调用懒启动。 */
  async warmEndpoint(): Promise<void> {
    if (!this.settings.get().browserUse) return;
    this.materializeMcpScript();
    await this.ensureHttp();
    log.info('browser', 'mcp endpoint warmed', { httpPort: this.httpPort });
  }

  /** 物化 MCP server 脚本（内容比对后幂等覆写，版本升级自动刷新）。 */
  private materializeMcpScript(): void {
    const file = this.mcpScriptPath();
    const stale = !existsSync(file) || readFileSync(file, 'utf8') !== MCP_SERVER_SCRIPT;
    if (stale) writeFileSync(file, MCP_SERVER_SCRIPT, 'utf8');
  }

  // ------------------------------------------------------------ HTTP 出口

  /** loopback HTTP 出口：MCP 脚本 tools/call 的统一入口（Bearer token 鉴权）。 */
  private async ensureHttp(): Promise<void> {
    if (this.http) return;
    this.http = createServer((req, res) => {
      void (async () => {
        try {
          if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            return;
          }
          if (req.method !== 'POST' || req.url !== '/call') {
            res.writeHead(404).end();
            return;
          }
          if (req.headers.authorization !== `Bearer ${this.token}`) {
            res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
            return;
          }
          const body = await readBody(req, CALL_BODY_MAX);
          const { sessionId, name, args } = JSON.parse(body) as {
            sessionId?: string;
            name?: string;
            args?: Record<string, unknown>;
          };
          if (!name) throw new Error('missing tool name');
          const result = await this.execute(sessionId ?? '', name, args ?? {});
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: msg }));
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.http.address();
    this.httpPort = typeof address === 'object' && address ? address.port : 0;
    // 端点落盘：MCP 脚本每次调用现读（spec 创建早于 HTTP 拉起的竞态解）。
    writeFileSync(join(this.mcpDir(), 'endpoint.json'), JSON.stringify({ port: this.httpPort }), 'utf8');
  }

  // ------------------------------------------------------------ 工具执行（出口统一钩子）

  /**
   * 所有动作执行的必经路径（MCP 转发 / 未来面板直调都走这里）：
   * 分级闸口 → 审批（如需要）→ playwright 执行 → 摘要审计 + 历史 + 状态推送。
   */
  async execute(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const def = toolDef(name);
    if (!def) return textResult(`未知工具：${name}`, true);
    if (!this.settings.get().browserUse) return textResult('browser use 未开启', true);

    const startedAt = Date.now();
    const summary = summarizeArgs(name, args);
    let ok = false;
    let error: string | undefined;
    try {
      if (this.status !== 'running') await this.ensure();
      if (this.status !== 'running') {
        error = `受管浏览器未就绪：${this.error ?? this.status}`;
        return textResult(error, true);
      }

      const gate = decideGate(def, args, this.settings.get().browserNavWhitelist);
      if (gate.decision === 'approve') {
        const approved = await this.requestApproval(sessionId, def, args, summary, gate.reason);
        if (!approved) {
          error = '用户拒绝或审批超时';
          return textResult(`动作被拒绝：${summary}`, true);
        }
      }

      const result = await this.run(def, args);
      ok = !result.isError;
      if (!ok) error = result.content[0]?.type === 'text' ? result.content[0].text : '执行失败';
      return result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // CDP 断连（用户手关了 Chrome 等）→ 重置连接态，下次调用重新拉起。
      if (/closed|disconnected|crash/i.test(error)) {
        this.pwBrowser = undefined;
        this.page = undefined;
      }
      return textResult(`执行失败：${error}`, true);
    } finally {
      this.recordAction(def, summary, Date.now() - startedAt, ok, error);
    }
  }

  /** playwright 执行体 —— 每个分支只做动作 + 返回预算内回执，绝不采集页面正文。 */
  private async run(def: BrowserToolDef, args: Record<string, unknown>): Promise<ToolResult> {
    const page = await this.currentPage();
    const timeout = TOOL_TIMEOUT_MS;
    switch (def.name) {
      case 'navigate_page': {
        const url = String(args.url ?? '');
        if (!/^https?:\/\//i.test(url)) return textResult('仅允许 http(s) 导航（file:/javascript: 等被禁止）', true);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await this.refreshPageInfo(page);
        return textResult(truncate(`已导航到 ${page.url()}（${this.pageTitle ?? ''}）`, BUDGET.confirmMaxChars));
      }
      case 'click': {
        const selector = String(args.selector ?? '');
        await page.click(selector, { timeout: 10_000 });
        return textResult(`已点击 ${selector}`);
      }
      case 'fill': {
        const selector = String(args.selector ?? '');
        const value = String(args.value ?? '');
        await page.fill(selector, value, { timeout: 10_000 });
        return textResult(`已输入 ${selector}（${value.length} 字符）`);
      }
      case 'scroll_page': {
        const amount = typeof args.amount === 'number' ? args.amount : 600;
        const dx = args.direction === 'left' ? -amount : args.direction === 'right' ? amount : 0;
        const dy = args.direction === 'up' ? -amount : args.direction === 'down' || !args.direction ? amount : 0;
        await page.mouse.wheel(dx, dy);
        return textResult(`已滚动 ${String(args.direction ?? 'down')} ${amount}px`);
      }
      case 'take_screenshot': {
        const data = await this.captureJpeg(page);
        if (!data) return textResult('截图超出预算上限，已丢弃', true);
        this.screenshot = `data:image/jpeg;base64,${data}`;
        return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }] };
      }
      case 'evaluate_script': {
        const script = String(args.script ?? '');
        const value: unknown = await page.evaluate(script);
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
        return textResult(truncate(text, BUDGET.evalResultMaxChars));
      }
      case 'list_pages': {
        const pages = this.context().pages();
        const titles = await Promise.all(pages.map((p) => p.title().catch(() => '')));
        const list = pages.map((p, i) => ({ index: i, url: p.url(), title: titles[i] ?? '', active: p === page }));
        return textResult(JSON.stringify(list, null, 2));
      }
      default:
        return textResult(`未实现的工具：${def.name}`, true);
    }
  }

  // ------------------------------------------------------------ 审批通道

  /**
   * 写动作/白名单外导航的审批：复用 PermissionSheet 通道
   * （permission.request，origin:'browser'；requestId 前缀 `browser:` 供
   * SessionManager 路由回本类）。无会话上下文时写动作直接拒绝（fail closed）。
   */
  private async requestApproval(
    sessionId: string,
    def: BrowserToolDef,
    args: Record<string, unknown>,
    summary: string,
    reason: string,
  ): Promise<boolean> {
    if (!sessionId || !this.target || this.target.isDestroyed()) {
      log.warn('browser', 'write action denied: no session context for approval', { tool: def.name });
      return false;
    }
    const preview = await this.buildPreview(def, args, summary, sessionId);
    const requestId = `browser:${randomUUID()}`;
    const envelope: EngineEventEnvelope = {
      sessionId,
      ts: Date.now(),
      event: {
        type: 'permission.request',
        turnId: 0,
        requestId,
        isQuestion: false,
        title: `[浏览器] ${summary}`,
        body: reason,
        options: [
          { optionId: 'allow', name: '允许', kind: 'allow_once' },
          { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
        ],
        origin: 'browser',
        browserAction: preview,
      },
    };
    this.target.send(IPC.engineEvent, envelope);
    log.info('browser', 'approval requested', { requestId, sessionId, tool: def.name, tier: def.tier });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.emitResolved(sessionId, requestId, undefined);
        log.warn('browser', 'approval timed out', { requestId, tool: def.name });
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(requestId, { sessionId, resolve, timer });
    });
  }

  /** SessionManager 应答路由的落点（requestId 前缀 `browser:` 已被拦截判定）。 */
  answerPermission(requestId: string, optionId?: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    this.emitResolved(p.sessionId, requestId, optionId);
    log.info('browser', 'approval answered', { requestId, optionId: optionId ?? '(cancelled)' });
    p.resolve(optionId === 'allow');
  }

  /** 解锁审批卡（超时/关停路径；用户应答路径渲染层已做乐观锁定，此事件兜底）。 */
  private emitResolved(sessionId: string, requestId: string, optionId: string | undefined): void {
    if (this.target && !this.target.isDestroyed()) {
      const envelope: EngineEventEnvelope = {
        sessionId,
        ts: Date.now(),
        event: { type: 'permission.resolved', requestId, optionId },
      };
      this.target.send(IPC.engineEvent, envelope);
    }
  }

  /** 审批卡动作回放素材：当前页截图 + fill 敏感字段探测 + 外发知悉。 */
  private async buildPreview(
    def: BrowserToolDef,
    args: Record<string, unknown>,
    summary: string,
    sessionId: string,
  ): Promise<BrowserActionPreview> {
    const preview: BrowserActionPreview = { tool: def.name, tier: def.tier, summary };
    if (typeof args.selector === 'string') preview.selector = args.selector;
    if (typeof args.x === 'number') preview.x = args.x;
    if (typeof args.y === 'number') preview.y = args.y;

    if (def.name === 'fill' && typeof args.selector === 'string') {
      try {
        const page = await this.currentPage();
        const attrs = await page
          .$eval(args.selector, (el) => ({
            type: el.getAttribute('type'),
            name: el.getAttribute('name'),
            id: el.getAttribute('id'),
            autocomplete: el.getAttribute('autocomplete'),
            'aria-label': el.getAttribute('aria-label'),
            placeholder: el.getAttribute('placeholder'),
          }))
          .catch(() => null);
        if (attrs && isSensitiveTarget(attrs)) preview.sensitive = true;
      } catch {
        /* 探测失败不强求 */
      }
    }

    try {
      const page = await this.currentPage();
      const data = await this.captureJpeg(page);
      if (data) preview.previewImage = `data:image/jpeg;base64,${data}`;
    } catch {
      /* 截图失败不阻塞审批 */
    }

    const engine = this.sessionInfo?.(sessionId)?.engine;
    preview.outbound = {
      captures: '当前页面截图与动作结果（回执文本/截图）',
      endpoint: engine ? `${engine} 引擎的模型端点` : '当前会话引擎的模型端点',
    };
    return preview;
  }

  /** 截图压缩唯一出口：固定视口 + JPEG 质量，超预算丢弃（返回 undefined）。 */
  private async captureJpeg(page: Page): Promise<string | undefined> {
    const buf = await page.screenshot({ type: 'jpeg', quality: BUDGET.screenshotQuality });
    const b64 = buf.toString('base64');
    if (b64.length > BUDGET.screenshotDataUrlMaxChars) {
      log.warn('browser', 'screenshot exceeds budget, dropped', { chars: b64.length });
      return undefined;
    }
    return b64;
  }

  private async refreshPageInfo(page: Page): Promise<void> {
    this.pageUrl = page.url();
    this.pageTitle = await page.title().catch(() => '');
  }

  // ------------------------------------------------------------ 审计

  /** 动作历史 + 日志：只记摘要（动作类型/目标选择器或坐标/耗时/成功否）；
   *  截图、页面 DOM、输入文本内容绝不落盘。 */
  private recordAction(def: BrowserToolDef, summary: string, durationMs: number, ok: boolean, error?: string): void {
    const record: BrowserActionRecord = {
      id: `ba-${++this.seq}`,
      tool: def.name,
      tier: def.tier as BrowserToolTier,
      summary,
      at: Date.now(),
      durationMs,
      ok,
      error,
    };
    this.actions.push(record);
    if (this.actions.length > ACTION_HISTORY_MAX) this.actions.splice(0, this.actions.length - ACTION_HISTORY_MAX);
    log.info('browser', 'tool executed', {
      tool: def.name,
      tier: def.tier,
      summary,
      durationMs,
      ok,
      ...(error ? { error: truncate(error, 200) } : {}),
    });
    this.pushState();
  }
}

// ------------------------------------------------------------ helpers

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** TOML basic string（codex -c 覆盖值用）：转义反斜杠与双引号。 */
function tomlBasic(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readBody(req: import('node:http').IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      buf += d;
      if (buf.length > max) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
