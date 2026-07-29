/**
 * 品牌视觉组件 — 「赛博老虎机」logo 与 loading 动效（黑金 Onyx 定稿）。
 * 图形语言（与 scripts/gen-icon.mjs 生成的 OS 图标同一设计）：
 * 线稿拉杆老虎机 + 转轮窗内三颗 AI 星芒 ✦✦✦（三个 agent 同场开奖 = 多模型赛马）。
 *
 * 三级出场（大厂响应式 logo 策略）：
 * - BrandSpinner：三星芒错峰脉冲，13px 起清晰，替代通用转圈（16 处 loading）；
 * - BrandMark：静态整机线稿，小尺寸自动省略窗内细节，跟随 currentColor；
 * - BrandHero：≥48px 大场面全叙事 — 拉杆下压回弹 + 机身微震 + 星芒逐颗点亮，内置香槟金渐变。
 */
import { useId } from 'react';

interface BrandProps {
  size?: number;
  className?: string;
}

/** 四角星芒 ✦ path（中心 0,0，凹弧四瓣） */
function starPath(r: number): string {
  const a = 0.105 * r;
  const b = 0.34 * r;
  return (
    `M 0 ${-r} C ${a} ${-b} ${b} ${-a} ${r} 0 C ${b} ${a} ${a} ${b} 0 ${r} ` +
    `C ${-a} ${b} ${-b} ${a} ${-r} 0 C ${-b} ${-a} ${-a} ${-b} 0 ${-r} Z`
  );
}

/* 24 单位设计稿（与 OS 图标一致）：机身(5.42,6.52,10.36,11.56)、窗(7.4,8.3,6.4,3)、
   星芒 ✦ @(8.6/10.6/12.6, 9.8)、出币槽 y16.1、拉杆球(18.8,6.5) */
function MachineGlyph({ detailed, stroke }: { detailed: boolean; stroke: number }): JSX.Element {
  return (
    <>
      <rect x="5.42" y="6.52" width="10.36" height="11.56" rx="1.8" fill="none" stroke="currentColor" strokeWidth={stroke} />
      <rect x="7.4" y="8.3" width="6.4" height="3" rx="0.75" fill="none" stroke="currentColor" strokeWidth={stroke * 0.78} />
      {detailed && (
        <>
          {[8.6, 10.6, 12.6].map((cx) => (
            <path key={cx} d={starPath(0.7)} transform={`translate(${cx} 9.8)`} fill="currentColor" stroke="none" />
          ))}
          <line x1="8.5" y1="16.1" x2="12.7" y2="16.1" stroke="currentColor" strokeWidth={stroke * 1.25} strokeLinecap="round" />
        </>
      )}
      <line x1="16.2" y1="12.3" x2="18.8" y2="12.3" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
      <line x1="18.8" y1="12.3" x2="18.8" y2="7.6" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
      <circle cx="18.8" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  );
}

/** 静态 logo — 用于标题栏 / 侧栏 / 关于页等程序名前缀。size<20 自动省略窗内细节保清晰。 */
export function BrandMark({ size = 16, className = '' }: BrandProps): JSX.Element {
  const detailed = size >= 20;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <MachineGlyph detailed={detailed} stroke={detailed ? 1.3 : 1.7} />
    </svg>
  );
}

/**
 * 品牌 loading — 三颗 AI 星芒错峰脉冲（agent 轮流思考），替代 lucide Loader2 + animate-spin。
 * spinning=false 时定格为静态三星（用于暂停/停止态，避免误导仍在运行）。
 */
export function BrandSpinner({ size = 14, className = '', spinning = true }: BrandProps & { spinning?: boolean }): JSX.Element {
  // 负 delay 让三星起始即处于错峰相位（正 delay 会先齐亮一闪）；
  // 平移必须放外层 g：动画的 CSS transform 会覆盖 path 自身的 SVG transform 属性，
  // 若同层则 translate 被 scale 顶掉，星芒全部掉回左上角原点
  const delays = ['0s', '-1s', '-0.8s'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      {[5, 12, 19].map((cx, i) => (
        <g key={cx} transform={`translate(${cx} 12)`}>
          <path d={starPath(3.1)} className={spinning ? 'brand-sparkle' : undefined} style={spinning ? { animationDelay: delays[i] } : undefined} />
        </g>
      ))}
    </svg>
  );
}

/**
 * 大场面动效（≥48px：启动屏 / 空状态 / 赛马开跑）— 完整拉霸仪式：
 * 拉杆下压 100° → 弹性回弹 → 机身微震 → 三颗星芒逐颗点亮 → 齐亮 → 同步熄灭循环（3.2s）。
 * 内置香槟金渐变（gradientUnits 必须 userSpaceOnUse：纯横/竖线段 objectBoundingBox 零面积会导致渐变失效不渲染）。
 */
export function BrandHero({ size = 96, className = '' }: BrandProps): JSX.Element {
  // useId 产物含冒号（:r0:），在 url(#…) fragment 中部分环境解析不稳，去掉后仍唯一
  const gid = `brand-gold-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const gold = `url(#${gid})`;
  // 星芒与拉杆的时序叙事：拉杆拉下后才依次爆亮、同步熄灭。
  // 每颗星各挂一组 keyframes（brand-jack-1/2/3），不可改回 delay 相位偏移（熄灭窗口会错开，丢失拉杆→中奖的因果感）
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="6" y2="24">
          <stop offset="0" stopColor="#f6e2a4" />
          <stop offset="0.5" stopColor="#c99d3f" />
          <stop offset="1" stopColor="#8f681e" />
        </linearGradient>
      </defs>
      <g className="brand-machine">
        <rect x="5.42" y="6.52" width="10.36" height="11.56" rx="1.8" fill="none" stroke={gold} strokeWidth="0.84" />
        <rect x="7.4" y="8.3" width="6.4" height="3" rx="0.75" fill="none" stroke={gold} strokeWidth="0.6" />
        {[8.6, 10.6, 12.6].map((cx, i) => (
          /* 平移在外层 g：避免动画 CSS transform 覆盖 translate（星芒会飞回原点）。
             fill 用窗框同阶金而非渐变：userSpaceOnUse 坐标系随 g 平移，星芒会取到顶端高亮金显突兀 */
          <g key={cx} transform={`translate(${cx} 9.8)`}>
            <path d={starPath(0.7)} fill="#cea54b" className={`brand-jack brand-jack-${i + 1}`} />
          </g>
        ))}
        <line x1="8.5" y1="16.1" x2="12.7" y2="16.1" stroke={gold} strokeWidth="1.1" strokeLinecap="round" />
      </g>
      <g className="brand-lever">
        <line x1="16.2" y1="12.3" x2="18.8" y2="12.3" stroke={gold} strokeWidth="0.84" strokeLinecap="round" />
        <line x1="18.8" y1="12.3" x2="18.8" y2="7.6" stroke={gold} strokeWidth="0.84" strokeLinecap="round" />
        <circle cx="18.8" cy="6.5" r="1.2" fill={gold} />
      </g>
    </svg>
  );
}
