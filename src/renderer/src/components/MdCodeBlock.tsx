/**
 * MdPre — markdown 围栏代码块：顶部语言标签 + 一键复制按钮。
 * 供 MessageItem / PlanDocPanel 的 ReactMarkdown `pre` 覆写使用；
 * 复制内容取 pre.textContent（对语法高亮后的纯文本同样成立）。
 * 结构样式见 index.css 的 .md-code-block。
 */

import { Children, isValidElement, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '../i18n';

export default function MdPre({ children }: { children?: ReactNode }): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // react-markdown v9 中 code 可能被业务组件覆写（MessageItem 的 MdCode），
  // 因此不能按元素类型找子节点，统一从子元素的 language- className 取语言。
  const lang = useMemo(() => {
    const code = Children.toArray(children).find(
      (c): c is ReactElement => isValidElement(c) && typeof (c.props as { className?: unknown } | undefined)?.className === 'string',
    );
    const cls = (code?.props as { className?: string } | undefined)?.className ?? '';
    return /language-([\w-]+)/.exec(cls)?.[1] ?? '';
  }, [children]);

  const copy = (): void => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="md-code-block">
      <div className="flex items-center gap-2 rounded-t-lg border border-b-0 border-line bg-bg-panel px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-4 text-ink-faint">{lang || t('codeBlock')}</span>
        <button
          type="button"
          onClick={copy}
          title={copied ? t('copied') : t('copyCode')}
          className="flex shrink-0 items-center rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
        >
          {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
