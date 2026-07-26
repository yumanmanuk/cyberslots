/**
 * FilePreview — read/edit a workspace file. Markdown opens in rendered
 * preview by default (spec F6); everything else shows as numbered plain
 * text. Edit mode is a plain editor with save (CodeMirror upgrade later).
 */

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code2, Eye, ExternalLink, Pencil, Save, X } from 'lucide-react';

import type { OpenTarget } from '@shared/ipc';

interface Props {
  path: string;
  root: string;
  onClose: () => void;
}

type Mode = 'preview' | 'source' | 'edit';

export default function FilePreview({ path, root, onClose }: Props): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [ext, setExt] = useState('');
  const [mode, setMode] = useState<Mode>('preview');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isMd = ext === 'md' || ext === 'markdown';
  const fileName = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);

  useEffect(() => {
    setText(null);
    setError(null);
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

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await window.cyberslots.fsWrite(path, draft, root);
      setText(draft);
      setMode(isMd ? 'preview' : 'source');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft" title={path}>
          {fileName}
        </span>
        {isMd && mode !== 'edit' && (
          <IconBtn title={mode === 'preview' ? '查看源码' : '预览'} onClick={() => setMode(mode === 'preview' ? 'source' : 'preview')}>
            {mode === 'preview' ? <Code2 size={13} /> : <Eye size={13} />}
          </IconBtn>
        )}
        {mode !== 'edit' ? (
          <IconBtn title="编辑" onClick={() => setMode('edit')}>
            <Pencil size={13} />
          </IconBtn>
        ) : (
          <IconBtn title={saving ? '保存中…' : '保存 (Ctrl+S)'} onClick={() => void save()}>
            <Save size={13} className={saving ? 'animate-pulse' : ''} />
          </IconBtn>
        )}
        <OpenInMenu path={path} />
        <IconBtn title="关闭" onClick={onClose}>
          <X size={13} />
        </IconBtn>
      </div>

      {truncated && <div className="bg-warn/10 px-2 py-1 text-[11px] text-warn">文件过大，仅预览前 512KB</div>}
      {error && <div className="bg-err/10 px-2 py-1 text-[11px] text-err">{error}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {text === null && !error ? (
          <div className="p-4 text-ui text-ink-faint">加载中…</div>
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
          <NumberedSource text={text ?? ''} />
        )}
      </div>
    </div>
  );
}

function NumberedSource({ text }: { text: string }): JSX.Element {
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <div className="flex font-mono text-[12px] leading-5">
      <div className="select-none border-r border-line bg-bg-panel px-2 py-2 text-right text-ink-faint">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="flex-1 overflow-x-auto whitespace-pre px-3 py-2">{text}</pre>
    </div>
  );
}

const OPEN_TARGETS: Array<{ id: OpenTarget; label: string }> = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'explorer', label: '文件管理器' },
  { id: 'gitbash', label: 'Git Bash' },
  { id: 'wt', label: 'Windows Terminal' },
];

function OpenInMenu({ path }: { path: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconBtn title="用外部程序打开" onClick={() => setOpen(!open)}>
        <ExternalLink size={13} />
      </IconBtn>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-20 min-w-36 rounded-lg border border-line bg-bg-input py-1 shadow-lg">
            {OPEN_TARGETS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setOpen(false);
                  void window.cyberslots.openIn(t.id, path);
                }}
                className="block w-full px-3 py-1.5 text-left text-ui text-ink hover:bg-bg-hover"
              >
                {t.label}
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
    <button title={title} onClick={onClick} className="rounded p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
      {children}
    </button>
  );
}
