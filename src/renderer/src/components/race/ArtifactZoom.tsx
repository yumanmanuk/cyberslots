/**
 * ArtifactZoom — 赛马产物放大查看弹层：全屏 markdown 阅读。
 * 标题标明产物归属（选手 A 方案 / 选手 A 反驳 / 裁判方案…），
 * 支持下载 md；Esc / 点遮罩 / ✕ 关闭。
 */

import { Download, X } from 'lucide-react';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { downloadMarkdown } from '../../planDoc';
import { useT } from '../../i18n';
import MdLink from '../MdLink';

export default function ArtifactZoom({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-4xl flex-col rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</span>
          <button
            title={t('raceDownloadMd')}
            onClick={() => downloadMarkdown(title, text)}
            className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <Download size={14} />
          </button>
          <button
            title={t('raceZoomClose')}
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="md-body text-[13px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>{text}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
