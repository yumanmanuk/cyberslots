/**
 * FilePreview — read/edit a workspace file. Markdown opens in rendered
 * preview by default (spec F6); code shows with highlight.js syntax
 * colors + line numbers. Edit mode is a plain editor with save.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { Code2, Eye, ExternalLink, FolderGit2, FolderOpen, MessageSquarePlus, Monitor, Pencil, Save, Terminal, X } from 'lucide-react';

import { useChatStore } from '../../store/chatStore';
import { BrandSpinner } from '../brand';
import { useT } from '../../i18n';

import type { OpenTarget } from '@shared/ipc';

/** ext → highlight.js language id（常见别名修正） */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  yml: 'yaml',
  ps1: 'powershell',
  sh: 'bash',
  toml: 'ini',
  vue: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
};

interface Props {
  path: string;
  root: string;
  /** 所属会话 —— 「添加到对话」把选区卡片投递到该会话的输入框。 */
  sessionId: string;
  /** 变化时重新读盘刷新（AI 编辑/回退后实时同步）。 */
  reloadKey?: string;
  onClose: () => void;
}

type Mode = 'preview' | 'source' | 'edit';

export default function FilePreview({ path, root, sessionId, reloadKey, onClose }: Props): JSX.Element {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [ext, setExt] = useState('');
  const [mode, setMode] = useState<Mode>('preview');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 非 null = 编辑中未保存，但 AI 已改磁盘 — 存磁盘新内容供冲突提示。 */
  const [conflict, setConflict] = useState<string | null>(null);

  const isMd = ext === 'md' || ext === 'markdown';
  const fileName = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);

  useEffect(() => {
    setText(null);
    setError(null);
    setConflict(null);
    window.cyberslots
      .fsRead(path)
      .then((f) => {
        setText(f.text);
        setDraft(f.text);
        setTruncated(f.truncated);
        setExt(f.ext);
        setMode(f.ext === 'md' || f.ext === 'markdown' ? 'preview' : 'source');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [path]);

  // AI 改动/回退后重新读盘 — 实时同步预览。编辑模式不覆盖未保存草稿；
  // 首渲染跳过（交由上面的 [path] 效果加载）。
  const firstRef = useRef(true);
  useEffect(() => {
    if (reloadKey === undefined) return;
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    window.cyberslots
      .fsRead(path)
      .then((f) => {
        // 编辑模式且有未保存改动：磁盘也变了 → 冲突，不覆盖草稿，弹提示条。
        if (mode === 'edit' && draft !== text) {
          if (f.text !== text) setConflict(f.text);
          return;
        }
        setText(f.text);
        setDraft(f.text);
        setTruncated(f.truncated);
        setExt(f.ext);
      })
      .catch(() => undefined); // 文件可能被回退删除：保留现有内容
  }, [reloadKey]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await window.cyberslots.fsWrite(path, draft, root);
      setText(draft);
      setConflict(null);
      setMode(isMd ? 'preview' : 'source');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft" title={path}>
          {fileName}
        </span>
        {isMd && mode !== 'edit' && (
          <IconBtn title={mode === 'preview' ? t('fpViewSource') : t('fpPreview')} onClick={() => setMode(mode === 'preview' ? 'source' : 'preview')}>
            {mode === 'preview' ? <Code2 size={13} /> : <Eye size={13} />}
          </IconBtn>
        )}
        {mode !== 'edit' ? (
          <IconBtn title={t('fpEdit')} onClick={() => setMode('edit')}>
            <Pencil size={13} />
          </IconBtn>
        ) : (
          <IconBtn title={saving ? t('fpSaving') : t('fpSave')} onClick={() => void save()}>
            {saving ? <BrandSpinner size={13} /> : <Save size={13} />}
          </IconBtn>
        )}
        <OpenInMenu path={path} />
        <IconBtn title={t('close')} onClick={onClose}>
          <X size={13} />
        </IconBtn>
      </div>

      {truncated && <div className="bg-warn/10 px-2 py-1 text-[11px] text-warn">{t('fpTooLarge')}</div>}
      {error && <div className="bg-err/10 px-2 py-1 text-[11px] text-err">{error}</div>}
      {conflict !== null && (
        <div className="flex items-center gap-2 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
          <span className="min-w-0 flex-1">{t('fpConflict')}</span>
          <button
            onClick={() => {
              setText(conflict);
              setDraft(conflict);
              setConflict(null);
            }}
            className="shrink-0 rounded-md bg-warn/20 px-2 py-0.5 font-medium hover:bg-warn/30"
          >
            {t('fpLoadAiVersion')}
          </button>
          <button onClick={() => setConflict(null)} className="shrink-0 rounded-md px-2 py-0.5 hover:bg-bg-hover">
            {t('fpKeepMine')}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {text === null && !error ? (
          <div className="flex items-center gap-2 p-4 text-ui text-ink-faint">
            <BrandSpinner size={12} /> {t('loading')}
          </div>
        ) : mode === 'edit' ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                void save();
              }
            }}
            spellCheck={false}
            className="h-full w-full resize-none bg-bg-input p-3 font-mono text-[12px] leading-5 outline-none"
          />
        ) : isMd && mode === 'preview' ? (
          <div className="md-body px-4 py-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text ?? ''}</ReactMarkdown>
          </div>
        ) : (
          <NumberedSource text={text ?? ''} ext={ext} path={path} fileName={fileName} sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}

/** 带行号的代码视图 — highlight.js 整块着色（token 可跨行），
 *  行号列与代码共享行高，滚动同步。 */
function NumberedSource({
  text,
  ext,
  path,
  fileName,
  sessionId,
}: {
  text: string;
  ext: string;
  path: string;
  fileName: string;
  sessionId: string;
}): JSX.Element {
  const t = useT();
  const addSelection = useChatStore((s) => s.addSelection);
  const lines = useMemo(() => text.split('\n'), [text]);
  const rootRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  /** 非 null = 选区浮动按钮（位置 + 已解析的行号/文本快照）。 */
  const [selBtn, setSelBtn] = useState<{ top: number; left: number; startLine: number; endLine: number; text: string } | null>(null);

  const html = useMemo(() => {
    const lang = LANG_BY_EXT[ext] ?? ext;
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
      // 未知扩展名：仅对小文件自动探测，大文件直接纯文本（autoDetect 很贵）。
      if (text.length < 60_000) return hljs.highlightAuto(text).value;
    } catch {
      /* fall through to plain text */
    }
    return undefined;
  }, [text, ext]);

  // 文件内容刷新（AI 改动/切文件）后旧选区快照作废 → 收起按钮。
  useEffect(() => setSelBtn(null), [text]);

  /** 把 DOM 选区钳制到 <pre> 内，换算成 1-based 行号 + 文本快照并定位浮动按钮。 */
  const evalSelection = (): void => {
    const pre = preRef.current;
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!pre || !root || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelBtn(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(pre)) {
      setSelBtn(null);
      return;
    }
    // 选区可能拖出代码区（截断提示条等）：首尾钳到 pre 内。
    const r = range.cloneRange();
    if (!pre.contains(r.startContainer)) r.setStart(pre, 0);
    if (!pre.contains(r.endContainer)) r.setEnd(pre, pre.childNodes.length);
    // 快照与行号永远自洽：截掉末尾多选的换行，终点行号由快照推出。
    const snapshot = r.toString().replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (!snapshot.trim()) {
      setSelBtn(null);
      return;
    }
    // 起始行号 = 起点前文本的换行数 + 1（跨 token 的 span 不影响 textContent 偏移）。
    const probe = document.createRange();
    probe.selectNodeContents(pre);
    probe.setEnd(r.startContainer, r.startOffset);
    const startLine = probe.toString().split('\n').length;
    const endLine = startLine + snapshot.split('\n').length - 1;
    // 按钮定位到选区末端右下角（相对 root，随内容一起滚动）。
    const rects = r.getClientRects();
    if (rects.length === 0) {
      setSelBtn(null);
      return;
    }
    const last = rects[rects.length - 1]!;
    const rootRect = root.getBoundingClientRect();
    setSelBtn({
      top: last.bottom - rootRect.top + 6,
      left: Math.max(8, Math.min(last.right - rootRect.left, rootRect.width - 150)),
      startLine,
      endLine,
      text: snapshot,
    });
  };

  // 选区在代码区外折叠/转移时收起按钮（点击空白、选到别的面板等）。
  useEffect(() => {
    const onSelChange = (): void => {
      const pre = preRef.current;
      const sel = window.getSelection();
      if (!pre || !sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.getRangeAt(0).intersectsNode(pre)) setSelBtn(null);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, []);

  const addToChat = (): void => {
    if (!selBtn) return;
    addSelection(sessionId, {
      id: crypto.randomUUID(),
      path,
      fileName,
      ext,
      startLine: selBtn.startLine,
      endLine: selBtn.endLine,
      text: selBtn.text,
    });
    window.getSelection()?.removeAllRanges();
    setSelBtn(null);
  };

  return (
    <div
      ref={rootRef}
      className="relative flex font-mono text-[12px] leading-5"
      onMouseUp={evalSelection}
      onKeyUp={(e) => {
        // 键盘 Shift+方向键选择也能触发。
        if (e.shiftKey) evalSelection();
      }}
    >
      <div className="select-none px-2 py-2 text-right text-ink-faint/70">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {html !== undefined ? (
        <pre ref={preRef} className="hljs flex-1 overflow-x-auto whitespace-pre bg-transparent px-3 py-2" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre ref={preRef} className="flex-1 overflow-x-auto whitespace-pre px-3 py-2">{text}</pre>
      )}
      {selBtn && (
        <button
          style={{ top: selBtn.top, left: selBtn.left }}
          // mousedown 阻止默认：保住 DOM 选区，click 才能拿到完整快照。
          onMouseDown={(e) => e.preventDefault()}
          onClick={addToChat}
          className="absolute z-20 flex animate-[sel-pop_.14s_ease-out] items-center gap-1.5 rounded-full bg-accent py-1 pl-2.5 pr-1.5 text-[11px] font-medium text-white shadow-lg shadow-accent/25 transition hover:brightness-110 active:scale-95"
        >
          <MessageSquarePlus size={12} />
          {t('addToChat')}
          {/* 选区行号徽标 — 投递前就能确认范围 */}
          <span className="rounded-full bg-white/20 px-1.5 font-mono text-[10px] leading-4 tabular-nums">
            {selBtn.startLine === selBtn.endLine ? `L${selBtn.startLine}` : `L${selBtn.startLine}-${selBtn.endLine}`}
          </span>
        </button>
      )}
    </div>
  );
}

const OPEN_TARGETS = [
  { id: 'vscode' as const, labelKey: null, label: 'VS Code', icon: Code2 },
  { id: 'explorer' as const, labelKey: 'fileManager' as const, label: '', icon: FolderOpen },
  { id: 'gitbash' as const, labelKey: null, label: 'Git Bash', icon: FolderGit2 },
  { id: 'wt' as const, labelKey: null, label: 'Terminal', icon: Monitor },
  { id: 'terminal' as const, labelKey: null, label: 'Powershell', icon: Terminal },
] satisfies Array<{ id: OpenTarget; labelKey: 'fileManager' | null; label: string; icon: typeof Code2 }>;

function OpenInMenu({ path }: { path: string }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconBtn title={t('railOpenIn')} onClick={() => setOpen(!open)}>
        <ExternalLink size={13} />
      </IconBtn>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-20 min-w-36 rounded-lg border border-line bg-bg-input py-1 shadow-lg">
            {OPEN_TARGETS.map((tg) => (
              <button
                key={tg.id}
                onClick={() => {
                  setOpen(false);
                  void window.cyberslots.openIn(tg.id, path);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-ink hover:bg-bg-hover"
              >
                <tg.icon size={16} className="text-ink-softer" />
                {tg.labelKey ? t(tg.labelKey) : tg.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button title={title} onClick={onClick} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
      {children}
    </button>
  );
}
