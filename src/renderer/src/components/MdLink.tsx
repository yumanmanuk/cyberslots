import type { MouseEvent, ReactNode } from 'react';

import { useChatStore } from '../store/chatStore';

/** 文件路径判定 — 必须命中已知扩展名白名单（对齐 FILE_ICONS + 常见文本类），
 *  宁可漏判也不把 `reasoning: true` / `chain_valid` 这类配置键误判成文件。
 *  MessageItem 的行内代码 chip 用这份严格规则；MdLink 的分流逻辑不同，
 *  见组件注释。 */
const FILE_EXT_RE =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|json|jsonc|md|markdown|css|scss|less|styl|vue|svelte|html?|xml|py|rs|go|java|kts?|c|h|cc|cpp|hpp|sh|bash|ps1|bat|cmd|ya?ml|toml|ini|env|conf|cfg|svg|png|jpe?g|gif|webp|ico|txt|lock|sql)$/i;

export function looksLikeFilePath(s: string): boolean {
  const v = s.trim();
  if (!v || v.length > 260 || /\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return false;
  const base = v.split(/[\\/]/).pop() ?? '';
  return FILE_EXT_RE.test(base);
}

/** 网页 URL 只认 http(s) —— 分流的第一道判据。 */
const WEB_URL_RE = /^https?:\/\//i;

/** 绝对路径：Windows 盘符 / UNC / POSIX 根。 */
const ABS_PATH_RE = /^([a-zA-Z]:[\\/]|\\\\|\/)/;

/** AI 引用文件常带行号：`foo.ts:42`、`README.md#L10`。 */
const LINE_SUFFIX_RE = /(?::\d+(?::\d+)?|#L\d+)$/i;

/** path 是否落在 root 内（分隔符归一 + Windows 大小写不敏感）。 */
function isUnder(path: string, root: string): boolean {
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(`${r}/`);
}

/**
 * MdLink — react-markdown 的统一 a 渲染器。分流逻辑（方向不能反）：
 * - **网页只认 http(s)://**：保持 target=_blank 默认行为，由主进程
 *   setWindowOpenHandler 拦截 → shell.openExternal 交系统浏览器
 *   （src/main/index.ts）。
 * - **其余一切 href 都视为文件候选，一律 preventDefault**，绝不让 <a>
 *   默认导航 —— 相对 href 在窗口里会被解析成 `http://localhost:5173/...`
 *   （dev）命中主进程外链白名单而误入浏览器，这是历史 bug 的根因。
 *   文件候选再按扩展名白名单筛一遍：命中的走文件分流（工作区内 → 右侧
 *   面板预览，requestFilePreview 内做模糊定位；工作区外绝对路径 → 文件
 *   管理器定位 openIn('explorer')）；没命中的点击不动作。
 *   注意这里比行内代码 chip 的 looksLikeFilePath 宽松（允许空格、
 *   剥行号后缀）——链接 href 是作者显式标注的目标，误判风险低。
 */
export default function MdLink({ href, children, sessionId }: { href?: string; children?: ReactNode; sessionId?: string }): JSX.Element {
  // markdown href 会百分号编码（空格 → %20），判定前解码；非法编码保留原文。
  let decoded = href ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw */
  }

  // 网页：交默认导航（主进程拦截进浏览器）。
  if (WEB_URL_RE.test(decoded)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }

  // 文件候选：剥 file:// 协议头与行号后缀后按扩展名白名单判定。
  const filePath = decoded.replace(/^file:\/\//i, '').replace(LINE_SUFFIX_RE, '');
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const isFile = filePath.length > 0 && filePath.length <= 500 && FILE_EXT_RE.test(base);

  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault(); // 非网页链接一律拦下，文件判定失败也原地不动
    if (!isFile) return;
    const store = useChatStore.getState();
    const meta = sessionId ? store.sessions.find((m) => m.id === sessionId) : undefined;
    const workCwd = meta && meta.chatMode === 'work' ? meta.cwd : null;
    if (ABS_PATH_RE.test(filePath)) {
      // 绝对路径：落在会话工作区内 → 面板预览；否则 → 文件管理器定位。
      if (workCwd && isUnder(filePath, workCwd)) store.requestFilePreview(sessionId!, filePath);
      else void window.cyberslots.openIn('explorer', filePath);
      return;
    }
    // 相对路径：依赖会话 cwd 解析，必然是工作区内文件 → 面板预览。
    if (workCwd && sessionId) store.requestFilePreview(sessionId, filePath);
  };

  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={onClick}>
      {children}
    </a>
  );
}
