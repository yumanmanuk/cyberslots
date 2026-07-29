---
trigger: always_on
---

# 品牌 loading 动效规范（强制）

本项目所有「进行中 / 等待 / 加载」指示一律使用品牌组件 `src/renderer/src/components/brand.tsx`，禁止通用 spinner。

> 本规范与根目录 `AGENTS.md` 的「品牌 loading 动效规范」一节内容一致（AGENTS.md 供 codex/kimi/opencode 等其他引擎读取）。修改任意一份时必须同步另一份。

## 组件选型

| 场景 | 组件 | 尺寸 |
|---|---|---|
| 行内 / 按钮 / 列表行 loading | `<BrandSpinner size={11~18} />`（三星芒✦错峰轮闪） | 11–18px |
| 大场面：空状态、整页/面板级等待、启动屏、仪式感场景 | `<BrandHero size={48~96} />`（拉杆全叙事动效） | ≥48px |
| 静态 logo（程序名前缀等） | `<BrandMark />` | 任意 |

## 硬性规则

- 禁止 `lucide Loader2` / `animate-spin` / `animate-pulse` 表达 loading；禁止无动效的纯文字「加载中…」——文字可保留，但必须搭配 BrandSpinner。
- 图标按钮的进行中态写法：`{busy ? <BrandSpinner size={n} /> : <原图标 />}`。
- 面板横幅类等待（宽 ≥300px、高 ≥60px）必须用 `BrandHero`，不要塞 15px 以下的 BrandSpinner（三星过小会退化成"三个灰点"，无品牌辨识度）。
- 暂停/停止态用 `<BrandSpinner spinning={false} />` 定格，不要让动画误导"仍在运行"。
- 品牌动画不加 `prefers-reduced-motion` 降级——loading 是运行状态语义而非装饰（历史决策，勿"规范化"回来）。
- **例外（不属于 loading，不受本规范约束）**：状态呼吸灯（会话状态点、待回答提醒、当前阶段高亮等 `animate-pulse` 状态指示）。

## SVG 动效技术红线（改 brand.tsx 时）

- 渐变必须 `gradientUnits="userSpaceOnUse"`——纯横/竖线段的 objectBoundingBox 为零面积，渐变会失效导致线段不渲染。
- 定位平移必须放外层 `<g transform="translate(…)">`，动画类只挂内层元素——CSS 动画的 transform 会整体覆盖元素自身的 SVG transform 属性，同层会让图形飞回原点。
