# AGENTS.md

CyberSlots（赛博老虎机）— Electron 多引擎 AI 赛马桌面客户端（codex / kimi / opencode / omp）。
主进程 `src/main`，渲染层 `src/renderer/src`（React + Tailwind + zustand），共享类型 `src/shared`。
`src/main/browser/` 是 browser use 工具服务层（受管 Chrome + playwright-core CDP + MCP server 喂给各引擎，`settings.browserUse` 全局开关默认关）；computer use（`src/main/computer/`）Phase 3 独立排期，未交付。

## 常用命令

- 开发：`npm run dev`（HMR）/ `npm run dev:frozen`（关 HMR）
- 类型检查（改完代码必跑）：`npm run typecheck`（= node + web 双配置）
- 构建 / 打包：`npm run build` / `npm run dist`
- OS 图标重新生成：`node scripts/gen-icon.mjs` → 产出 `resources/icon.png`

## 日志系统规范（强制）

本程序行为全量留痕、引擎行为归引擎。完整设计与 scope 表见 `docs/logging.md`，要点：

- 主进程用 `src/main/log/logger.ts` 的 `log.info/warn/error/debug(scope, msg, data?, err?)`；渲染进程用 `src/renderer/src/log/logger.ts` 的 `rlog.*`（经 IPC 批量转发主进程落盘）。
- 落盘：`userData/logs/main|renderer-YYYY-MM-DD.jsonl`（JSONL 按天切分，保留 14 天）；`compat-audit.jsonl` 是独立的协议审计通道，不混用。
- **禁止** `console.log/warn/error` 直接表达程序行为（logger 内部镜像除外）；新增模块必须接 logger。
- 引擎 CLI 自己的日志/stdout 正文不进本日志；只记本程序侧：生命周期、spawn 命令行摘要（脱敏）、exit code、意外退出时的 stderr 尾部、协议异常摘要。
- browser/computer 工具服务层用 scope `browser` / `browser.host`（将来 `computer`）：只记动作摘要（动作类型/目标选择器或坐标/耗时/成功否）；截图、页面 DOM、页面正文、输入文本内容**绝不落盘**。
- `data` 只放摘要（id/计数/耗时/路径），禁止正文/payload/消息流（`text.delta` 等事件流绝不入日志）；敏感字段名自动打码，但密钥本身永不入参。
- IPC handler 抛错由 `src/main/ipc.ts` 的统一 `handle()` 包装自动记 error，handler 内不要重复记同一个错。

## 品牌 loading 动效规范（强制）

所有「进行中 / 等待 / 加载」指示一律使用品牌组件 `src/renderer/src/components/brand.tsx`，禁止通用 spinner。
实现任何 loading / 等待 / 进行中效果时，**必须先查本节**，按决策树选型，不得引入 lucide / 系统 spinner。

### 三级品牌动效层级

品牌动效共三级，级别越高视觉分量越重，按容器大小和场景语义选择：

#### Lv1 — BrandSpinner（行内脉冲）

```tsx
<BrandSpinner size={14} />           // 默认 14px，running 态
<BrandSpinner size={16} spinning />  // 显式 running
<BrandSpinner size={14} spinning={false} />  // 暂停/停止态：三星定格，不闪
```

- **动效**：三颗 AI 星芒 ✦✦✦ 错峰脉冲（1.2s 周期，各错开 0.4s），视觉语义 = 「三个 agent 轮流思考」
- **尺寸范围**：11–18px（`size < 11` 三星退化为灰点，失去品牌辨识度）
- **适用场景**：按钮进行中态、列表行 loading、输入框附属指示、Toast 角标、任何行内小图标位
- **典型写法**：`{busy ? <BrandSpinner size={14} /> : <OriginalIcon />}`

#### Lv2 — BrandHero（大场面全叙事）

```tsx
<BrandHero size={48} />   // 面板级，最小推荐
<BrandHero size={96} />   // 启动屏 / 空状态页，默认
```

- **动效**：完整拉霸仪式（3.2s 循环）— 拉杆下压 100° → 弹性回弹 → 机身微震 → 三颗星芒逐颗点亮 → 齐亮 → 同步熄灭；金色三档渐变（`--brand-hi/mid/lo`，暗色为 Onyx 香槟金）
- **尺寸范围**：≥ 48px（小于 48 细节退化，请降级到 BrandSpinner）
- **适用场景**：整页/面板级等待（面板宽 ≥300px 且高 ≥60px）、空状态占位、启动屏、仪式感操作（赛马开跑、会话 fork 等）
- **布局**：居中 flex 列，图标下方配说明文字（如 `正在加载…`）

#### Lv0 — BrandMark（静态 logo，非动效）

```tsx
<BrandMark size={16} />   // 程序名前缀，size < 20 自动省略窗内细节
<BrandMark size={24} />   // 含窗内细节的完整线稿
```

- **动效**：无，纯静态 SVG 线稿
- **用途**：标题栏 / 侧栏程序名前缀、关于页、版权行等**非 loading 场景**
- **注意**：不表达任何「进行中」语义，不要用于 loading

### AI 选型决策树

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

### 硬性规则

- 禁止 `lucide Loader2` / `animate-spin` / `animate-pulse` 表达 loading；禁止无动效的纯文字「加载中…」——文字可保留，但必须搭配 BrandSpinner 或 BrandHero。
- 图标按钮的进行中态写法：`{busy ? <BrandSpinner size={n} /> : <原图标 />}`。
- 面板横幅类等待（宽 ≥300px、高 ≥60px）必须用 `BrandHero`，不要塞 15px 以下的 BrandSpinner（三星过小会退化成「三个灰点」，无品牌辨识度）。
- 暂停/停止态用 `<BrandSpinner spinning={false} />` 定格，不要让动画误导「仍在运行」。
- 品牌动画不加 `prefers-reduced-motion` 降级——loading 是运行状态语义而非装饰（历史决策，勿「规范化」回来）。
- **例外（不属于 loading，不受本规范约束）**：状态呼吸灯（会话状态点、待回答提醒、当前阶段高亮等 `animate-pulse` 状态指示）。

### SVG 动效技术红线（改 brand.tsx 时）

- 渐变必须 `gradientUnits="userSpaceOnUse"`——纯横/竖线段的 objectBoundingBox 为零面积，渐变会失效导致线段不渲染。
- 定位平移必须放外层 `<g transform="translate(…)">`，动画类只挂内层元素——CSS 动画的 transform 会整体覆盖元素自身的 SVG transform 属性，同层会让图形飞回原点。

> 本节与 `.qoder/rules/brand-loading.md` 内容一致（后者供 Qoder 自动注入）。修改任意一份时必须同步另一份。

## 行内混排对齐规范（强制）

单行内混排「图标/刻度/spinner + 不同字号、不同字体（sans/mono）的文字」时（工具行、状态行、卡片头、队列行等），一律按此配方，已全量实测（基线 delta = 0，图标/文本中心差 ≤1px）：

1. 行容器用 `items-baseline`；**非文本项**（图标、刻度条、BrandSpinner、徽章 chip、按钮）一律加 `self-center`。
2. 当行内最高项不是文字（图标按钮 19/20px、或定高行）时，**主文本 span 的行高必须设为行内容高**（如 20px 行用 `leading-[20px]`，GoalBar 用 `leading-[19px]`）让文本盒填满行——否则 baseline 文本组顶格打包、图标却居中，二者错位（竖线与 Ran 错位、loading 与 Exploring 错位都是这个病）。
3. 文本天然是最高项的行（`text-ui` 13/20、卡片标题行）直接 `items-baseline` 即可，无需改行高。
4. **禁止用 `leading-none` 修混字号对齐**——em 盒居中 ≠ 基线对齐，sans/mono ascent 比例不同，实测反而更糟（-1.5px → -1.75px）。
5. svg 直子的图标按钮一律 `flex items-center justify-center`（inline 按钮里 svg 按基线排版会偏高 ~2px）。
6. 输入框胶囊（`.oc-file-chip`）：外对齐 `vertical-align: text-top`（不能用 baseline——首 flex 项有无基线三种胶囊各不相同）；内部小字（`</>`、行号）`line-height: 1`。
7. BrandSpinner 全实例相位已由 `animationstart` 监听把 `startTime` 钉零全局同步——不要在实例上用 `Date.now()` 之类重算 `animation-delay`（重渲染会重定时导致漂移）。
