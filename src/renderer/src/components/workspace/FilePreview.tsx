/**
 * FilePreview — read/edit a workspace file. Markdown opens in rendered
 * preview by default (spec F6); code shows with highlight.js syntax
 * colors + line numbers. Edit mode is a plain editor with save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import CodeMirror from '@uiw/react-codemirror';
import { languages } from '@codemirror/language-data';
import { foldService, HighlightStyle, LanguageDescription, syntaxHighlighting, type LanguageSupport } from '@codemirror/language';
import { Compartment, RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { search } from '@codemirror/search';
import { Decoration, EditorView, GutterMarker, highlightTrailingWhitespace, keymap, lineNumberMarkers, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { Code2, Eye, ExternalLink, FolderGit2, FolderOpen, MessageSquarePlus, Monitor, Pencil, Save, Terminal, X } from 'lucide-react';

import type { GitBaseContent } from '@shared/ipc';
import { useChatStore } from '../../store/chatStore';
import { BrandSpinner } from '../brand';
import { useT } from '../../i18n';
import { computeLineDiff, EMPTY_LINE_DIFF, type LineDiff } from './diffRows';
import MdLink from '../MdLink';

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

/** git 状态徽标配色（与文件树 GIT_COLORS 同语义）：新增绿 / 修改琥珀 / 删除红 / 重命名蓝。 */
const GIT_BADGE_CLS: Record<string, string> = {
  M: 'bg-warn/15 text-warn',
  A: 'bg-ok/15 text-ok',
  U: 'bg-ok/15 text-ok',
  D: 'bg-err/15 text-err',
  R: 'bg-info/15 text-info',
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

/** 编辑模式 CodeMirror 主题：底色交给容器，行号/光标/选区跟随主题变量，
 *  token 色取 --code-*（与预览模式 .hljs 同一色板）。 */
const CM_THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'Iosevka, "Cascadia Code", Consolas, monospace', lineHeight: '20px' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: 'none', color: 'var(--ink-faint)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 8px 0 12px', textAlign: 'right' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg-active) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--bg-active) 55%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  // ── 搜索 / 替换面板 ──
  '.cm-panel.cm-search': {
    backgroundColor: 'var(--bg-input)',
    color: 'var(--ink)',
    borderBottom: '1px solid var(--line)',
    padding: '6px 8px 4px',
    fontSize: '12px',
    '& input, & button, & label': { margin: '.2em .5em .2em 0' },
    '& input[type=checkbox]': { marginRight: '.2em' },
    '& label': { fontSize: '80%', whiteSpace: 'pre', display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--ink-faint)' },
    '& [name=close]': {
      position: 'absolute',
      top: '4px',
      right: '4px',
      backgroundColor: 'inherit',
      border: 'none',
      font: 'inherit',
      padding: 0,
      margin: 0,
      cursor: 'pointer',
      color: 'var(--ink-faint)',
      fontSize: '16px',
      '&:hover': { color: 'var(--ink)' },
    },
  },
  '.cm-textfield': {
    backgroundColor: 'var(--bg)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '12px',
    outline: 'none',
  },
  '.cm-textfield:focus': { borderColor: 'var(--accent)' },
  '.cm-button': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--ink-soft)',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    padding: '2px 8px',
    fontSize: '11px',
    cursor: 'pointer',
  },
  '.cm-button:hover': { backgroundColor: 'var(--bg-hover)', color: 'var(--ink)' },
  // ── 自动补全 / 工具提示 ──
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-input)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgb(0 0 0 / 14%)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--ink)' },
  '.cm-completionDetail': { color: 'var(--ink-faint)', marginLeft: '6px', fontSize: '10.5px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'Iosevka, "Cascadia Code", Consolas, monospace', fontSize: '12px', maxHeight: '220px' },
  // ── 代码折叠 ──
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', color: 'var(--ink-faint)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-active)',
    color: 'var(--ink-soft)',
    border: '1px solid var(--line)',
    borderRadius: '3px',
    margin: '0 2px',
  },
  // ── 匹配高亮（搜索命中 / 选中词 / 括号）──
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
  },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)' },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
  },
  '.cm-trailingSpace': { backgroundColor: 'color-mix(in srgb, var(--err) 22%, transparent)' },
});

/** token 色映射 — 与 index.css 的 .hljs 规则逐类对应。 */
const CM_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--ink-faint)', fontStyle: 'italic' },
  {
    tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier],
    color: 'var(--code-keyword)',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted, tags.attributeName, tags.attributeValue],
    color: 'var(--code-string)',
  },
  { tag: [tags.number, tags.bool, tags.atom, tags.typeName, tags.link], color: 'var(--code-number)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.className, tags.name, tags.labelName, tags.definition(tags.variableName)],
    color: 'var(--code-title)',
  },
  {
    tag: [tags.variableName, tags.propertyName, tags.definition(tags.propertyName), tags.standard(tags.variableName), tags.self],
    color: 'var(--code-attr)',
  },
  { tag: tags.deleted, color: 'var(--err)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
]);

/** 稳定的 basicSetup 配置：对象引用必须恒定，否则 @uiw/react-codemirror 每次渲染
 *  都会重建整套扩展（折叠状态/选区装饰被无谓重置）。 */
const CM_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLineGutter: true,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
  autocompletion: true,
  closeBrackets: true,
  bracketMatching: true,
  rectangularSelection: true,
  searchKeymap: true,
  completionKeymap: true,
  foldKeymap: true,
} as const;

/** 行首缩进数（tab 按 1 计）。 */
const countIndent = (s: string): number => {
  const m = /^\s*/.exec(s);
  return m ? m[0].length : 0;
};

/** 缩进折叠兜底：语法树无可折叠节点（纯文本 / 未知扩展名 / 语法折叠失效）时，
 *  按「子行缩进更深」折叠，让任意文本文件都有折叠能力。 */
const INDENT_FOLD = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const indent = countIndent(line.text);
  if (indent === 0 || line.length === 0) return null;
  let end = line.to;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n);
    if (next.length === 0) {
      end = next.to;
      continue;
    }
    if (countIndent(next.text) > indent) {
      end = next.to;
      continue;
    }
    break;
  }
  return end > line.to ? { from: line.to, to: end } : null;
});

/** 行号 gutter 的 diff 标记（elementClass 加到对应 .cm-gutterElement 上）。 */
class DiffGutterMarker extends GutterMarker {
  constructor(override readonly elementClass: string) {
    super();
  }

  override eq(other: DiffGutterMarker): boolean {
    return other.elementClass === this.elementClass;
  }
}

/** 按行号表构建行背景装饰 + gutter 标记（1-based 行号 → add/mod/del）。 */
function buildDiffField(doc: EditorState['doc'], d: LineDiff): { deco: DecorationSet; markers: RangeSet<GutterMarker> } {
  const deco = new RangeSetBuilder<Decoration>();
  const markers = new RangeSetBuilder<GutterMarker>();
  for (let ln = 1; ln <= doc.lines; ln++) {
    const kind = d.rows.get(ln);
    const line = doc.line(ln);
    if (kind) {
      deco.add(line.from, line.from, Decoration.line({ class: kind === 'add' ? 'cm-diff-line-add' : 'cm-diff-line-mod' }));
      markers.add(line.from, line.from, new DiffGutterMarker(kind === 'add' ? 'cm-diff-gutter-add' : 'cm-diff-gutter-mod'));
    } else if (d.dels.has(ln)) {
      markers.add(line.from, line.from, new DiffGutterMarker('cm-diff-gutter-del'));
    }
  }
  return { deco: deco.finish(), markers: markers.finish() };
}

export default function FilePreview({ path, root, sessionId, reloadKey, onClose }: Props): JSX.Element {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [ext, setExt] = useState('');
  const [mode, setMode] = useState<Mode>('preview');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 编辑模式语法高亮语言（按文件名异步匹配，未命中则纯文本）。 */
  const [editLang, setEditLang] = useState<LanguageSupport | null>(null);
  /** git 基准（HEAD 内容 + 文件状态）；null = 未拉取/非 git。 */
  const [gitBase, setGitBase] = useState<GitBaseContent | null>(null);
  /** 状态栏：光标行/列 + 选区字符数。 */
  const [stat, setStat] = useState({ line: 1, col: 1, selLen: 0 });
  /** 非 null = 编辑中未保存，但 AI 已改磁盘 — 存磁盘新内容供冲突提示。 */
  const [conflict, setConflict] = useState<string | null>(null);

  const isMd = ext === 'md' || ext === 'markdown';
  const fileName = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 始终持有最新标记表：CodeMirror StateField 的 create/update 从 ref 读取，
  // 避免扩展重建与 React 渲染的时序竞态。
  // 行级变更标记：随 git 基准 / 草稿实时重算（未保存编辑也参与，效果同 VS Code）。
  // 非 git、无变更（status 空）或二进制（base null 且非新增）→ 无标记。
  const lineDiff = useMemo(() => {
    if (!gitBase || !gitBase.status) return EMPTY_LINE_DIFF;
    if (gitBase.base == null && gitBase.status !== 'U' && gitBase.status !== 'A') return EMPTY_LINE_DIFF;
    return computeLineDiff(gitBase.base, draft);
  }, [gitBase, draft]);
  const lineDiffRef = useRef(lineDiff);
  lineDiffRef.current = lineDiff;

  // 拉取 git 基准：切文件时清零旧标记，到达后按当前草稿重算。
  useEffect(() => {
    let alive = true;
    setGitBase(null);
    lineDiffRef.current = EMPTY_LINE_DIFF;
    void window.cyberslots.gitBaseContent(root, path).then((g) => {
      if (!alive) return;
      setGitBase(g);
      // 标记表由 useMemo 随 gitBase 重算；这里只需刷新 ref 供编辑器 reconfig。
      lineDiffRef.current = computeLineDiff(g.base, draftRef.current);
    });
    return () => {
      alive = false;
    };
  }, [root, path]);

  // 编辑语言按扩展名匹配（language-data 内含 js/ts/py/rs/yaml/html/md 等），
  // 首次进入编辑时短暂异步加载，之后复用。
  useEffect(() => {
    let alive = true;
    setEditLang(null);
    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (!desc) return () => { alive = false; };
    void desc.load().then((ls) => {
      if (alive) setEditLang(ls);
    });
    return () => { alive = false; };
  }, [fileName]);

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

  const save = useCallback(async (): Promise<void> => {
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
  }, [draft, isMd, path, root]);

  // keymap 引用最新 save，但不随每次输入重建扩展（避免编辑器频繁重配置）。
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  // git 行级标记：StateField 固定配置 + 显式 StateEffect 重建。
  // 关键：不能只靠 docChanged 时才更新 —— git 基准到达 / 切文件时文档没变，
  // 旧装饰（空或上一个文件的）会一直挂着，表现为「要真的改一次才出标记」。
  // 这里由下面的 effect 派发 diffRebuild，让字段用最新行号表整体重建。
  const diffRebuild = useMemo(() => StateEffect.define<LineDiff>(), []);
  const diffField = useMemo(
    () =>
      StateField.define<{ deco: DecorationSet; markers: RangeSet<GutterMarker> }>({
        create: (state) => buildDiffField(state.doc, lineDiffRef.current),
        update: (v, tr) => {
          for (const e of tr.effects) {
            if (e.is(diffRebuild)) return buildDiffField(tr.state.doc, e.value);
          }
          if (tr.docChanged) return { deco: v.deco.map(tr.changes), markers: v.markers.map(tr.changes) };
          return v;
        },
        provide: (f) => [
          EditorView.decorations.from(f, (v) => v.deco),
          lineNumberMarkers.from(f, (v) => v.markers),
        ],
      }),
    [diffRebuild],
  );
  const diffCompartment = useMemo(() => new Compartment(), []);
  const editorViewRef = useRef<EditorView | null>(null);
  const updateStat = useCallback((view: EditorView): void => {
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    setStat({ line: line.number, col: sel.head - line.from + 1, selLen: Math.abs(sel.to - sel.from) });
  }, []);
  useEffect(
    () => () => {
      editorViewRef.current = null;
    },
    [],
  );

  // 标记表变化（git 基准到达 / 每次编辑）→ 派发重建 effect，让新行号表生效。
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || !gitBase?.status) return;
    view.dispatch({ effects: diffRebuild.of(lineDiff) });
  }, [diffRebuild, gitBase, lineDiff]);

  const editExtensions = useMemo(
    () => [
      CM_THEME,
      INDENT_FOLD,
      search({ top: true }),
      syntaxHighlighting(CM_HIGHLIGHT),
      highlightTrailingWhitespace(),
      keymap.of([{ key: 'Mod-s', run: () => { void saveRef.current(); return true; } }]),
      diffCompartment.of(diffField),
      ...(editLang ? [editLang] : []),
    ],
    [editLang, diffCompartment, diffField],
  );

  // 稳定回调：@uiw/react-codemirror 的 reconfigure 依赖这些 prop 的引用，
  // 每次渲染传新函数会触发整套扩展重建（折叠状态被抖掉）。
  const handleChange = useCallback((v: string) => setDraft(v), []);
  const handleUpdate = useCallback(
    (vu: ViewUpdate) => {
      if (vu.selectionSet || vu.docChanged) updateStat(vu.view);
    },
    [updateStat],
  );
  const handleCreate = useCallback(
    (view: EditorView) => {
      editorViewRef.current = view;
      updateStat(view);
    },
    [updateStat],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft" title={path}>
          {fileName}
        </span>
        {gitBase?.status && (
          <span className={`shrink-0 rounded px-1.5 py-[1px] font-mono text-[10px] font-bold ${GIT_BADGE_CLS[gitBase.status] ?? 'text-ink-faint'}`}>
            {gitBase.status}
          </span>
        )}
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
          <div className="flex h-full min-h-0 flex-col">
            <div className="relative min-h-0 flex-1">
              <CodeMirror
                value={draft}
                onChange={handleChange}
                extensions={editExtensions}
                height="100%"
                theme="none"
                className="h-full bg-bg-input"
                onCreateEditor={handleCreate}
                onUpdate={handleUpdate}
                basicSetup={CM_BASIC_SETUP}
              />
              {gitBase?.status && <DiffOverview lineDiff={lineDiff} total={Math.max(1, draft.split('\n').length)} />}
            </div>
            <EditorStatusBar stat={stat} ext={ext} gitBase={gitBase} />
          </div>
        ) : isMd && mode === 'preview' ? (
          <div className="md-body px-4 py-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>{text ?? ''}</ReactMarkdown>
          </div>
        ) : (
          <NumberedSource text={text ?? ''} ext={ext} path={path} fileName={fileName} sessionId={sessionId} lineDiff={lineDiff} />
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
  lineDiff,
}: {
  text: string;
  ext: string;
  path: string;
  fileName: string;
  sessionId: string;
  lineDiff: LineDiff;
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
      <div className="select-none py-2 text-right text-ink-faint/70">
        {lines.map((_, i) => {
          const ln = i + 1;
          const kind = lineDiff.rows.get(ln) ?? (lineDiff.dels.has(ln) ? 'del' : null);
          return (
            <div
              key={i}
              className={`relative px-2 ${kind === 'add' ? 'pv-diff-gutter-add' : kind === 'mod' ? 'pv-diff-gutter-mod' : kind === 'del' ? 'pv-diff-gutter-del' : ''}`}
            >
              {ln}
            </div>
          );
        })}
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
      {(lineDiff.rows.size > 0 || lineDiff.dels.size > 0) && (
        <DiffOverview lineDiff={lineDiff} total={Math.max(1, lines.length)} />
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

/** 右侧变更概览条（VS Code overview ruler 语义）：整文件高度按行号映射，
 *  新增绿 / 修改琥珀 / 删除红；只画有变更的行，行数多时自动压缩。 */
function DiffOverview({ lineDiff, total }: { lineDiff: LineDiff; total: number }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const marks = useMemo(() => {
    const out: Array<{ top: number; kind: 'add' | 'mod' | 'del' }> = [];
    if (!height || total <= 0) return out;
    const step = height / total;
    const push = (line: number, kind: 'add' | 'mod' | 'del'): void => {
      out.push({ top: Math.max(0, Math.min(height - 3, (line - 1) * step)), kind });
    };
    for (const [ln, kind] of lineDiff.rows) push(ln, kind);
    for (const ln of lineDiff.dels) push(ln, 'del');
    return out;
  }, [height, lineDiff, total]);

  return (
    <div ref={ref} className="absolute bottom-2 right-2 top-2 w-[4px] overflow-hidden rounded-full bg-bg-hover/70">
      {marks.map((m, i) => (
        <div
          key={i}
          className={`absolute left-0 w-full rounded-full ${m.kind === 'add' ? 'bg-ok' : m.kind === 'mod' ? 'bg-warn' : 'bg-err'}`}
          style={{ top: m.top, height: 3 }}
        />
      ))}
    </div>
  );
}

/** 编辑状态栏：光标行/列、选区字符数、语言、git 状态、编码（VS Code 底栏风格）。 */
function EditorStatusBar({
  stat,
  ext,
  gitBase,
}: {
  stat: { line: number; col: number; selLen: number };
  ext: string;
  gitBase: GitBaseContent | null;
}): JSX.Element {
  const gitCls =
    gitBase?.status === 'M'
      ? 'text-warn'
      : gitBase?.status === 'A' || gitBase?.status === 'U'
        ? 'text-ok'
        : gitBase?.status === 'D'
          ? 'text-err'
          : 'text-info';
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line bg-bg-panel/40 px-3 py-[3px] font-mono text-[10.5px] text-ink-faint">
      <span className="tabular-nums">行 {stat.line}，列 {stat.col}</span>
      {stat.selLen > 0 && <span className="tabular-nums">已选 {stat.selLen} 字符</span>}
      <span className="ml-auto">{ext ? ext.toUpperCase() : 'PLAIN TEXT'}</span>
      {gitBase?.status && <span className={`font-bold ${gitCls}`}>{gitBase.status}</span>}
      <span>UTF-8</span>
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
