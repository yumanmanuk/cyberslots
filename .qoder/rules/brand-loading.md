---
trigger: always_on
---

# 品牌 loading 动效规范（强制）

本项目所有「进行中 / 等待 / 加载」指示一律使用品牌组件 `src/renderer/src/components/brand.tsx`，禁止通用 spinner。
实现任何 loading / 等待 / 进行中效果时，**必须先查本节**，按决策树选型，不得引入 lucide / 系统 spinner。

> 本规范与根目录 `AGENTS.md` 的「品牌 loading 动效规范」一节内容一致（AGENTS.md 供 codex/kimi/opencode 等其他引擎读取）。修改任意一份时必须同步另一份。

## 三级品牌动效层级

品牌动效共三级，级别越高视觉分量越重，按容器大小和场景语义选择：

### Lv1 — BrandSpinner（行内脉冲）

```tsx
<BrandSpinner size={14} />           // 默认 14px，running 态
<BrandSpinner size={16} spinning />  // 显式 running
<BrandSpinner size={14} spinning={false} />  // 暂停/停止态：三星定格，不闪
```

- **动效**：三颗 AI 星芒 ✦✦✦ 错峰脉冲（1.2s 周期，各错开 0.4s），视觉语义 = 「三个 agent 轮流思考」
- **尺寸范围**：11–18px（`size < 11` 三星退化为灰点，失去品牌辨识度）
- **适用场景**：按钮进行中态、列表行 loading、输入框附属指示、Toast 角标、任何行内小图标位
- **典型写法**：`{busy ? <BrandSpinner size={14} /> : <OriginalIcon />}`

### Lv2 — BrandHero（大场面全叙事）

```tsx
<BrandHero size={48} />   // 面板级，最小推荐
<BrandHero size={96} />   // 启动屏 / 空状态页，默认
```

- **动效**：完整拉霸仪式（3.2s 循环）— 拉杆下压 100° → 弹性回弹 → 机身微震 → 三颗星芒逐颗点亮 → 齐亮 → 同步熄灭；金色三档渐变（`--brand-hi/mid/lo`，暗色为 Onyx 香槟金）
- **尺寸范围**：≥ 48px（小于 48 细节退化，请降级到 BrandSpinner）
- **适用场景**：整页/面板级等待（面板宽 ≥300px 且高 ≥60px）、空状态占位、启动屏、仪式感操作（赛马开跑、会话 fork 等）
- **布局**：居中 flex 列，图标下方配说明文字（如 `正在加载…`）

### Lv0 — BrandMark（静态 logo，非动效）

```tsx
<BrandMark size={16} />   // 程序名前缀，size < 20 自动省略窗内细节
<BrandMark size={24} />   // 含窗内细节的完整线稿
```

- **动效**：无，纯静态 SVG 线稿
- **用途**：标题栏 / 侧栏程序名前缀、关于页、版权行等**非 loading 场景**
- **注意**：不表达任何「进行中」语义，不要用于 loading

## AI 选型决策树

实现 loading / 等待效果时，按以下顺序判断：

```
需要表达「进行中 / 等待 / 加载」？
│
├─ 容器宽 ≥300px 且高 ≥60px（面板级 / 整页占位）
│   └─→ BrandHero size={48~96}（Lv2）
│
├─ 行内 / 按钮 / 列表行 / 小区域（容器 < 60px）
│   ├─ running 态  → BrandSpinner size={11~18} spinning（Lv1）
│   └─ 暂停/停止态 → BrandSpinner size={11~18} spinning={false}（Lv1 定格）
│
└─ 非 loading（程序名 / 关于 / 版权等静态展示）
    └─→ BrandMark（Lv0，无动效）
```

## 硬性规则

- 禁止 `lucide Loader2` / `animate-spin` / `animate-pulse` 表达 loading；禁止无动效的纯文字「加载中…」——文字可保留，但必须搭配 BrandSpinner 或 BrandHero。
- 图标按钮的进行中态写法：`{busy ? <BrandSpinner size={n} /> : <原图标 />}`。
- 面板横幅类等待（宽 ≥300px、高 ≥60px）必须用 `BrandHero`，不要塞 15px 以下的 BrandSpinner（三星过小会退化成「三个灰点」，无品牌辨识度）。
- 暂停/停止态用 `<BrandSpinner spinning={false} />` 定格，不要让动画误导「仍在运行」。
- 品牌动画不加 `prefers-reduced-motion` 降级——loading 是运行状态语义而非装饰（历史决策，勿「规范化」回来）。
- **例外（不属于 loading，不受本规范约束）**：状态呼吸灯（会话状态点、待回答提醒、当前阶段高亮等 `animate-pulse` 状态指示）。

## SVG 动效技术红线（改 brand.tsx 时）

- 渐变必须 `gradientUnits="userSpaceOnUse"`——纯横/竖线段的 objectBoundingBox 为零面积，渐变会失效导致线段不渲染。
- 定位平移必须放外层 `<g transform="translate(…)">`，动画类只挂内层元素——CSS 动画的 transform 会整体覆盖元素自身的 SVG transform 属性，同层会让图形飞回原点。
