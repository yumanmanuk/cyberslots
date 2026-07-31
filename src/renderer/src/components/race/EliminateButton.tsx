/**
 * EliminateButton — ✂ 剔除选手的二段确认按钮（归档二段确认同款交互）：
 * 第一次点击进入武装态（变红「确认剔除?」），再点执行；3 秒未确认自动复位。
 * 剔除不可逆（第一版无复活），由调用方保证仅在允许窗口内渲染。
 */

import { Scissors } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '../../i18n';

export default function EliminateButton({
  label,
  onConfirm,
}: {
  /** 目标选手名（用于 tooltip，如「选手 C」）。 */
  label: string;
  onConfirm: () => void;
}): JSX.Element {
  const t = useT();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      title={
        armed
          ? t('raceEliminateArmedTitle')
          : t('raceEliminateTitle', { label })
      }
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition ${armed
          ? 'border-err bg-err/10 font-medium text-err'
          : 'border-line text-ink-faint hover:border-err/50 hover:text-err'
        }`}
    >
      <Scissors size={10} /> {armed ? t('raceEliminateConfirm') : t('raceEliminate')}
    </button>
  );
}
