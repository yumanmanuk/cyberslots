/**
 * UndoConfirmDialog — 「回退到某个提问」的确认弹窗（Claude Code 的
 * Confirm Undo 同款）：列出将被一并撤销的本会话文件变更（+N -M / A·M·D /
 * 多会话共编警示）；空集但有未归属变更时给出数量提示；无快照时给出降级
 * 说明。确认即执行回退。
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { SessionChangeEntry, UndoPreview } from '@shared/ipc';
import { useT } from '../i18n';
import { BrandSpinner } from './brand';

const STATUS_BADGE: Record<SessionChangeEntry['status'], { label: string; cls: string }> = {
  modified: { label: 'M', cls: 'text-warn' },
  added: { label: 'A', cls: 'text-ok' },
  deleted: { label: 'D', cls: 'text-err' },
  accepted: { label: '✓', cls: 'text-ok' },
};

export default function UndoConfirmDialog({
  preview,
  onConfirm,
  onClose,
}: {
  /** undefined = 加载中；null = 该提问无快照；{files: []} = 无本会话文件变更。 */
  preview: UndoPreview | null | undefined;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onConfirm()
      .then(onClose)
      .catch((err) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[70vh] w-[440px] flex-col rounded-2xl border border-line bg-bg p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">{t('undoConfirmTitle')}</span>
          <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {preview === undefined ? (
          <div className="flex items-center gap-2 py-4 text-ui text-ink-soft">
            <BrandSpinner size={14} />
          </div>
        ) : preview === null ? (
          <div className="text-ui leading-6 text-ink-soft">{t('undoConfirmNoSnapshot')}</div>
        ) : preview.files.length === 0 ? (
          <div className="text-ui leading-6 text-ink-soft">
            {t('undoConfirmNoFiles')}
            {/* 空集兜底：快照后有变更但不归属于本对话（用户手改/他会话/构建副作用），
                不会被回退 —— 数量显式透出，避免文件残留却无任何信号。 */}
            {preview.unattributed > 0 && <div className="mt-1 text-ink-faint">{t('undoConfirmUnattributed', { n: preview.unattributed })}</div>}
          </div>
        ) : (
          <>
            <div className="text-ui leading-6 text-ink-soft">{t('undoConfirmFiles')}</div>
            <div className="mt-2 min-h-0 overflow-y-auto rounded-xl border border-line bg-bg-input py-1">
              {preview.files.map((c) => (
                <div key={c.path} title={c.path} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                  <span className={`w-3 shrink-0 text-center font-mono text-[10px] ${STATUS_BADGE[c.status].cls}`}>{STATUS_BADGE[c.status].label}</span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.sessions > 1 && (
                    <span
                      title={t('wsMultiSessionTitle', { n: c.sessions })}
                      className="shrink-0 rounded bg-warn/15 px-1 text-[10px] text-warn"
                    >
                      {t('wsSessionsBadge', { n: c.sessions })}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-ok">+{c.adds}</span>
                  <span className="font-mono text-[11px] text-err">-{c.dels}</span>
                </div>
              ))}
            </div>
            {/* 跨会话共编警示：共享 cwd 下磁盘物理共享，回退会一并还原并影响其他会话。 */}
            {preview.files.some((c) => c.sessions > 1) && (
              <div className="mt-2 text-[12px] leading-5 text-warn">{t('undoConfirmShared')}</div>
            )}
          </>
        )}

        {error && <div className="mt-2 text-[12px] text-err">{t('undoFailed')}：{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover">
            {t('cancel')}
          </button>
          <button
            onClick={confirm}
            disabled={busy || preview === undefined}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-5 py-1.5 text-ui font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {busy && <BrandSpinner size={12} />}
            {t('undoConfirmBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
