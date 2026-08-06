/**
 * browser use 工具策略层 —— 纯函数、无 electron/playwright 依赖（vitest 直测）。
 *
 * 设计要点（对应方案 Phase 1/2）：
 * - 工具原语 schema 对齐 chrome-devtools-mcp（navigate_page / click / fill /
 *   scroll_page / take_screenshot / evaluate_script / list_pages）；
 * - 动作分级以本文件的 schema 元数据（tier 字段）声明，不在事件流上做
 *   toolName 字符串匹配；
 * - 上下文预算硬约束集中在 BUDGET 常量：eval 结果截断、截图压缩参数、
 *   确认文本长度上限；页面正文/DOM 根本不采集（无 snapshot 工具）。
 */

import type { BrowserToolTier } from '@shared/types';

// ---------------------------------------------------------- 上下文预算

export const BUDGET = {
  /** evaluate_script 返回值的字符上限（超出截断并标注）。 */
  evalResultMaxChars: 4000,
  /** 单条工具确认文本（navigate/click/fill/scroll 回执）的字符上限。 */
  confirmMaxChars: 200,
  /** 截图视口（受管页固定视口，兼作降分辨率手段）。 */
  viewport: { width: 1280, height: 800 },
  /** 截图 JPEG 质量（截图一律 jpeg，不进 png）。 */
  screenshotQuality: 50,
  /** 面板/卡片里的截图 data URL 字符上限（超出丢弃并记 warn）。 */
  screenshotDataUrlMaxChars: 600_000,
} as const;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[已截断 ${text.length - max} 字符]`;
}

// ---------------------------------------------------------- 工具清单

export interface BrowserToolDef {
  /** MCP 工具名（chrome-devtools-mcp 风格）。 */
  name: string;
  /** 动作分级元数据 —— 审批分级的唯一依据。 */
  tier: BrowserToolTier;
  description: string;
  /** JSON Schema（MCP inputSchema 原样下发）。 */
  inputSchema: Record<string, unknown>;
}

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: 'navigate_page',
    tier: 'navigate',
    description: 'Navigate the managed browser tab to a URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to navigate to.' } },
      required: ['url'],
    },
  },
  {
    name: 'click',
    tier: 'write',
    description: 'Click an element located by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector of the element to click.' } },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    tier: 'write',
    description: 'Type text into an input/textarea located by CSS selector (replaces existing value).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input element.' },
        value: { type: 'string', description: 'Text to enter.' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'scroll_page',
    tier: 'write',
    description: 'Scroll the page in a direction by a pixel amount.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels to scroll (default 600).' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'take_screenshot',
    tier: 'read',
    description: 'Capture a compressed JPEG screenshot of the current page (viewport-sized).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'evaluate_script',
    tier: 'write',
    description: 'Evaluate a JavaScript expression in the page and return its (truncated) result.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JavaScript expression to evaluate.' } },
      required: ['script'],
    },
  },
  {
    name: 'list_pages',
    tier: 'read',
    description: 'List open tabs (index, url, title, active) of the managed browser.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function toolDef(name: string): BrowserToolDef | undefined {
  return BROWSER_TOOLS.find((t) => t.name === name);
}

// ---------------------------------------------------------- 域名白名单

/** navigate 白名单匹配：条目为小写主机名；`*.example.com` 匹配 example.com
 *  本身及其任意子域。 */
export function hostMatchesWhitelist(host: string, whitelist: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of whitelist) {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) {
      const suffix = e.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------- 审批分级

export type GateDecision = { decision: 'allow' } | { decision: 'approve'; reason: string };

/**
 * 动作出口闸口（纯判定，执行在 BrowserService）：
 * - read → 放行（只读动作在各 PermissionMode 下均无副作用）；
 * - navigate → 目标主机在白名单内放行，否则强制审批（导航改变页面状态
 *   且有钓鱼风险，不算只读）；
 * - write → 必须审批。
 */
export function decideGate(def: BrowserToolDef, args: Record<string, unknown>, navWhitelist: string[]): GateDecision {
  if (def.tier === 'read') return { decision: 'allow' };
  if (def.tier === 'navigate') {
    const url = typeof args.url === 'string' ? args.url : '';
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* 非法 URL 按白名单外处理 → 审批 */
    }
    if (host && hostMatchesWhitelist(host, navWhitelist)) return { decision: 'allow' };
    return { decision: 'approve', reason: host ? `导航目标 ${host} 不在域名白名单内` : `导航地址非法：${url}` };
  }
  return { decision: 'approve', reason: '写动作必须经用户审批' };
}

// ---------------------------------------------------------- 敏感字段

const SENSITIVE_RE = /pass(word)?|pwd|cvv|cvc|cc[-_]|credit|card|pay(ment)?|alipay|wechat|银行|支付|密码/i;

/** type 目标是否 password/支付类字段（审批卡片高亮警示用）。
 *  输入为目标元素的属性快照（type/name/id/autocomplete/aria-label/placeholder）。 */
export function isSensitiveTarget(attrs: Record<string, string | null | undefined>): boolean {
  if ((attrs.type ?? '').toLowerCase() === 'password') return true;
  return ['name', 'id', 'autocomplete', 'aria-label', 'placeholder'].some((k) => SENSITIVE_RE.test(attrs[k] ?? ''));
}

// ---------------------------------------------------------- 摘要（日志/审批卡共用）

/** 动作的人类可读摘要 —— 输入文本只给长度，绝不携带内容（日志与审批卡
 *  共用同一摘要，天然满足「正文不落盘」。 */
export function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  const sel = typeof args.selector === 'string' ? args.selector : undefined;
  switch (tool) {
    case 'navigate_page':
      return `导航 → ${typeof args.url === 'string' ? args.url : '(无效 URL)'}`;
    case 'click':
      return `点击 ${sel ?? '(无选择器)'}`;
    case 'fill': {
      const len = typeof args.value === 'string' ? args.value.length : 0;
      return `输入 ${sel ?? '(无选择器)'}（${len} 字符）`;
    }
    case 'scroll_page':
      return `滚动 ${String(args.direction ?? 'down')} ${typeof args.amount === 'number' ? args.amount : 600}px`;
    case 'take_screenshot':
      return '截图（jpeg 压缩）';
    case 'evaluate_script': {
      const len = typeof args.script === 'string' ? args.script.length : 0;
      return `执行脚本（${len} 字符）`;
    }
    case 'list_pages':
      return '列出标签页';
    default:
      return tool;
  }
}
