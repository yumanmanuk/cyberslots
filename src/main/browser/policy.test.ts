/**
 * browser use 策略层单测：动作分级（schema 元数据）、navigate 域名白名单、
 * 敏感字段识别、摘要防泄漏（输入文本绝不进摘要）、截断预算。
 */

import { describe, expect, it } from 'vitest';

import {
  BROWSER_TOOLS,
  BUDGET,
  decideGate,
  hostMatchesWhitelist,
  isSensitiveTarget,
  summarizeArgs,
  toolDef,
  truncate,
} from './policy';

describe('工具清单与分级元数据', () => {
  it('七个原语齐备且每个都带 tier', () => {
    const names = BROWSER_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['click', 'evaluate_script', 'fill', 'list_pages', 'navigate_page', 'scroll_page', 'take_screenshot']);
    for (const t of BROWSER_TOOLS) expect(['read', 'navigate', 'write']).toContain(t.tier);
  });

  it('分级符合方案：只读=截图/列表，navigate 单列，其余为写', () => {
    expect(toolDef('take_screenshot')!.tier).toBe('read');
    expect(toolDef('list_pages')!.tier).toBe('read');
    expect(toolDef('navigate_page')!.tier).toBe('navigate');
    for (const n of ['click', 'fill', 'scroll_page', 'evaluate_script']) expect(toolDef(n)!.tier).toBe('write');
  });
});

describe('navigate 域名白名单', () => {
  const wl = ['example.com', '*.foo.bar'];

  it('精确命中与 *.后缀 命中', () => {
    expect(hostMatchesWhitelist('example.com', wl)).toBe(true);
    expect(hostMatchesWhitelist('a.foo.bar', wl)).toBe(true);
    expect(hostMatchesWhitelist('foo.bar', wl)).toBe(true); // *.foo.bar 覆盖裸域
    expect(hostMatchesWhitelist('deep.a.foo.bar', wl)).toBe(true);
  });

  it('未命中：邻近域/大小写混杂/后缀拼接欺骗', () => {
    expect(hostMatchesWhitelist('evil-example.com', wl)).toBe(false);
    expect(hostMatchesWhitelist('example.com.evil.cn', wl)).toBe(false);
    expect(hostMatchesWhitelist('notfoo.bar', wl)).toBe(false);
    expect(hostMatchesWhitelist('EXAMPLE.COM', wl)).toBe(true); // 大小写不敏感
  });
});

describe('出口闸口 decideGate', () => {
  it('read 无条件放行', () => {
    expect(decideGate(toolDef('take_screenshot')!, {}, []).decision).toBe('allow');
    expect(decideGate(toolDef('list_pages')!, {}, []).decision).toBe('allow');
  });

  it('write 必须审批', () => {
    for (const n of ['click', 'fill', 'scroll_page', 'evaluate_script']) {
      expect(decideGate(toolDef(n)!, { selector: '#a' }, ['example.com']).decision).toBe('approve');
    }
  });

  it('navigate：白名单内放行、白名单外审批、非法 URL 审批', () => {
    expect(decideGate(toolDef('navigate_page')!, { url: 'https://example.com/x' }, ['example.com']).decision).toBe('allow');
    expect(decideGate(toolDef('navigate_page')!, { url: 'https://sub.example.com/x' }, ['*.example.com']).decision).toBe('allow');
    expect(decideGate(toolDef('navigate_page')!, { url: 'https://phish.cn/x' }, ['example.com']).decision).toBe('approve');
    expect(decideGate(toolDef('navigate_page')!, { url: 'not-a-url' }, ['example.com']).decision).toBe('approve');
  });
});

describe('敏感字段识别（password/支付）', () => {
  it('type=password 直接命中', () => {
    expect(isSensitiveTarget({ type: 'password' })).toBe(true);
  });

  it('name/id/autocomplete/placeholder 语义命中', () => {
    expect(isSensitiveTarget({ type: 'text', name: 'card_cvv' })).toBe(true);
    expect(isSensitiveTarget({ type: 'text', id: 'alipay-account' })).toBe(true);
    expect(isSensitiveTarget({ type: 'text', autocomplete: 'cc-number' })).toBe(true);
    expect(isSensitiveTarget({ type: 'text', placeholder: '请输入支付密码' })).toBe(true);
  });

  it('普通字段不误报', () => {
    expect(isSensitiveTarget({ type: 'text', name: 'username', id: 'search' })).toBe(false);
    expect(isSensitiveTarget({ type: 'email', name: 'email' })).toBe(false);
  });
});

describe('摘要防泄漏与预算', () => {
  it('fill 摘要只带字符数，绝不携带输入内容', () => {
    const value = 'S3cret-不要乱传';
    const s = summarizeArgs('fill', { selector: '#pwd', value });
    expect(s).toContain('#pwd');
    expect(s).toContain(String(value.length)); // 只带字符数
    expect(s).not.toContain('S3cret');
    expect(s).not.toContain('乱传');
  });

  it('evaluate_script 摘要只带脚本长度', () => {
    const s = summarizeArgs('evaluate_script', { script: 'document.title' });
    expect(s).not.toContain('document.title');
  });

  it('truncate 超预算截断并标注', () => {
    const long = 'x'.repeat(BUDGET.evalResultMaxChars + 100);
    const t = truncate(long, BUDGET.evalResultMaxChars);
    expect(t.length).toBeLessThan(long.length);
    expect(t).toContain('已截断');
  });
});
