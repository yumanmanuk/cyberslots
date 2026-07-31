# CyberSlots UI 借鉴 Codex 桌面客户端 — 任务交接（Handoff）

> 目的：把「渲染层 UI 对标 Codex 桌面客户端」这批改动交接给下一个 agent 继续实现。
> 本文档已 **决策完整（decision-complete）**：接手方无需再做产品选择，按各任务的实现要点直接编码即可。
> 全部结论均基于对 `src/renderer/src/` 的完整只读调查（components 约 30 文件 + race/ 子目录），已核对到具体文件与行号。

---

## 一、背景与目标

CyberSlots 是 Electron 多引擎 AI 赛马桌面客户端（codex / kimi / opencode / omp / antigravity / claude）。
本项目**已明确以 codex-desktop / Notion 视觉语言为设计基准**（`tailwind.config.js` 与 `MessageItem.tsx` 文件头注释均有说明），大量 Codex 设计已借鉴到位：右对齐灰气泡、工具调用折叠汇总、内联 effort 滑条、PlanDoc 卡片、权限下拉两行副标题、右侧 tab 化 dock 等。

用户看了 Codex 桌面客户端后，希望**再借鉴几个还没做的设计点**。经确认，本轮**只做 4 项**（下节），目标是让界面更接近 Codex 的「干净、信息聚焦」观感。

---

## 二、任务范围（务必遵守）

**要做（4 项）：**
1. **最终 AI 回复正文里的可点击文件 chip**（带类型图标，点击在右侧面板打开该文件预览）。
2. **回合级「Worked for Xm Xs」折叠**：回合结束后把过程块整体坍缩成一行，点击展开。
3. **会话标题「更多（⋯）」菜单 → 重命名会话** + **超长用户提问消息折叠（约 10 行）+ 展开按钮**。
4. **Composer 加号（+）菜单**：把「放大输入框」移进去，并新增「选择文件」入口；**引擎图标保持最左侧不动**。

**明确不做（用户已否决，切勿实现）：**
- ❌ 用户消息 hover 的「编辑并重发 / 点赞 / 踩」。
- ❌ 高危权限模式（yolo/Full access）的警示色。
- ❌ 内置浏览器面板 / webview 预览。
- ❌ 语音输入。

> 对应用户原话："467 不做"（指上一轮编号里的 4/6/7）；"引擎应该还是在最左侧，这个是本次对话的根本"。

---

## 三、全局硬性约束（每一条都要守）

1. **品牌 loading 规范（强制）**：所有「进行中/等待/加载」一律用 `src/renderer/src/components/brand.tsx` 的 `BrandSpinner` / `BrandHero` / `BrandMark`，**禁止** `lucide Loader2` / `animate-spin` / `animate-pulse` 表达 loading。详见 `.qoder/rules/brand-loading.md` 与 `AGENTS.md`（两份内容一致，改任一份须同步）。本轮基本不涉及新 loading，但若用到务必遵守。
2. **改完必跑类型检查**：`npm run typecheck`（= node + web 双配置）。这是验收前置条件。
3. **i18n 双语**：所有新增用户可见文案都要在 `src/renderer/src/i18n.ts` 的 `zh` 与 `en` 两个字典里各加一条（结构见第六节），组件里用 `useT()` 取 key，**不要硬编码中文/英文字符串**。
4. **复用既有模式**：优先复用现有组件与交互范式（`DotMenu`、`Dropdown`、`FileTypeIcon`、`Collapsible`、`fmtDuration` 等），不要另起炉灶。
5. 不加 `prefers-reduced-motion` 降级（历史决策）。
6. 开发命令：`npm run dev`（HMR）/ `npm run dev:frozen`（关 HMR）。用户环境是 Windows PowerShell，命令分隔用 `;` 不要用 `&&`。

---

## 四、关键文件地图

| 文件 | 作用 | 本轮涉及任务 |
|---|---|---|
| `src/renderer/src/components/MessageItem.tsx` | 各类消息渲染（用户气泡 / AI markdown / 思考块 / 工具卡 / diff）。含 `FILE_ICONS` 表与 `FileTypeIcon`（**任务1直接复用**） | 1, 3 |
| `src/renderer/src/components/MessageList.tsx` | 消息流构建 `buildStream`（已把连续工具聚合成 explore/shell 组）；活动窗、完成态摘要 | 2 |
| `src/renderer/src/components/ChatView.tsx` | 聊天三段式布局；header 会话标题行（`h-12`，约 line 273-280）；右侧 dock 开合 | 1, 3 |
| `src/renderer/src/components/Composer.tsx` | 输入框整卡（1899 行）；控件条在 line 564-629；`ExpandDialog` 在 line 1793；`onDrop` 附件逻辑 line 392-438 | 4 |
| `src/renderer/src/components/Sidebar.tsx` | 含可复用的 `DotMenu` 组件（line 897-970）+ `DotMenuItem` 类型 | 3（参考/复用） |
| `src/renderer/src/components/workspace/WorkspacePanel.tsx` | 右侧文件/变更面板；`openFile` 本地 state（line 42）打开 `FilePreview` | 1 |
| `src/renderer/src/components/workspace/FileTree.tsx` | 含 `ownerRoot(path, roots)`（line 21）判定路径归属根 | 1 |
| `src/renderer/src/store/chatStore.ts` | zustand store；接口定义 line 108-220；`renameSession` 已实现（line 927）；`planPreview` 跨组件信号范式（line 116/161/584）可照抄 | 1, 3 |
| `src/renderer/src/i18n.ts` | 双语字典（zh line ~11 起，en 约 line ~600 起） | 1,2,3,4 |
| `src/preload/index.ts` | `getPathForFile(file)` 已暴露（line 120），拖拽/选择文件取绝对路径用 | 4 |

**已确认的现成能力（直接用，别重复造）：**
- `renameSession(id, title)`：store（line 927）与 IPC `session:rename` 都已存在，任务 3 直接调。
- `FileTypeIcon` / `FILE_ICONS`：`MessageItem.tsx` line 818-848，扩展名→lucide 图标+品牌色，任务 1 直接复用。
- `getPathForFile`：preload 已暴露，`<input type=file>` 选出的 File 可取绝对路径，任务 4 无需新增 IPC。
- `fmtDuration(ms)`：`MessageItem.tsx` line 430（`<60s → Ns`，否则 `Nm Ns`），任务 2 复用。
- `Collapsible`（`MessageItem.tsx` line 441，导出）：grid-rows 0fr↔1fr 平滑展开，任务 2 复用。
- `DotMenu`（`Sidebar.tsx` line 910）：⋯ 菜单，支持二次确认项，任务 3 可复用或抽取共用。

---

## 五、任务详解

### 任务 1：最终 AI 回复正文的可点击文件 chip ⭐

**现状**：AI 回复走 `MessageItem.tsx` 的 `case 'text'`（line 56-62），用 `ReactMarkdown`（**v9**，见 `package.json` `react-markdown: ^9.0.1`）渲染，文件路径只是纯文本/行内代码，不可点击、无图标。而工具/编辑卡（EditCard）里早有 `FileTypeIcon` 能力。

**目标**：把 AI 正文里「看起来像文件路径」的**行内代码**渲染成带图标的 chip，点击在右侧 dock 的「文件」tab 打开该文件预览（Codex 同款）。

**实现要点**：

1. 在 `MessageItem.tsx` 的 `case 'text'` 里给 `ReactMarkdown` 传 `components={{ code: ... }}`：
   - react-markdown v9 **没有 `inline` 属性**；用 className 是否含 `language-` 区分：**有 `language-xxx` = 围栏代码块**（保持默认渲染），**无 = 行内代码**。
   - 行内代码再判 `looksLikeFilePath(text)`：命中 → 渲染 `<FileChip>`；否则 → 默认 `<code>`。
2. `looksLikeFilePath(s)` 判定（**要严格，避免把 `reasoning: true`、`chain_valid`、`status` 误判成文件**）：
   - 去空白；含空白字符则否；排除 `http(s)://`。
   - 取 basename（按 `/` `\` 切最后一段），要求 basename 命中**已知扩展名白名单**（直接复用/对齐 `FILE_ICONS` 的扩展名集合：ts/tsx/js/jsx/mjs/cjs/json/md/css/scss/vue/svelte/html/py/rs/go/java/c/h/cpp/sh/ps1/yml/yaml/toml/ini/env/svg/png/jpg… 另可加 txt/lock/sql）。
   - 用「必须有已知扩展名」这条即可排除绝大多数误判（`chain_valid` 无点、`3.14` 扩展名 `14` 不在白名单）。
3. `FileChip` 组件（放 `MessageItem.tsx`）：
   - label 用**模型原文**（保留 `src/main/index.ts` 这种相对路径原样，不要只截 basename——保留上下文）；图标用 `FileTypeIcon name={basename}`。
   - 样式：行内 `inline-flex items-center gap-1 rounded-md border border-line bg-bg-panel px-1.5 py-px font-mono text-[0.9em] text-ink-soft hover:bg-bg-hover hover:text-ink`，`align-baseline`，`title={原文路径}`。
   - `onClick`：仅当会话 `chatMode === 'work'` 时调用 `requestFilePreview(sessionId, rawPath)`（下述 store 新增）。
4. **跨组件打开预览的 store 信号**（照抄现有 `planPreview` 范式）：
   - 在 `chatStore` state 加 `pendingFilePreview: Record<string, { path: string; nonce: number } | undefined>`（接口 + 初始值 `{}`）。
   - 加 action `requestFilePreview(sessionId, rawPath)`：取 `meta`（非 work 直接 return）；相对路径按 **cwd 的分隔符风格** join 成绝对路径（cwd 含 `\` 用 `\`，否则 `/`；相对路径里的 `/` 替换成该分隔符）；`set` 写入 `{ path, nonce: Date.now() }`。
5. `ChatView.tsx`：`const pf = useChatStore(s => s.pendingFilePreview[sessionId])`；`useEffect([pf])` 里若有值则 `setActiveTab('files'); setPanelOpen(true)`（**ChatView 不清除信号**）。
6. `WorkspacePanel.tsx`：读同一信号；`useEffect` 里 `setOpenDiff(null); setOpenFile(pending.path)`，然后**消费清除**（`useChatStore.setState` 把该 sessionId 置 undefined）。这样即便点击时 dock 未挂载，也是「ChatView 先开 files tab → WorkspacePanel 挂载后再消费」的顺序，稳妥。

**验收**：AI 回复里出现的 `xxx.ts` 等带上了图标 chip；点击后右侧自动开 files tab 并打开该文件；`reasoning: true` / `status` 等不被误判成文件；typecheck 通过。

---

### 任务 2：回合级「Worked for Xm Xs」折叠 ⭐（最复杂，重点看）

**用户已确认的语义**：执行**过程中维持现有逻辑**（活动窗、explore/shell 组折叠等，一切不动）；**回合真正结束后**，把该回合的过程整体坍缩成一行 `Worked for Xm Xs`，点击可展开还原现有的分组明细。

**过程 vs 结论的判定规则（已敲定）：**
- 以**用户消息为界切「回合」**，每条消息带 `turnId`（见 `src/shared/types.ts` `UnifiedMessage`，每个变体都有 `turnId`）。
- **回合「完成」的判定 = 该 turnId 存在 `turn_end` 消息**。没有 turn_end = 进行中 → 完全不折叠，走现状逻辑。（这样无需再看 session.status，天然覆盖流式中。）
- **最终结论 = 回合内「最后一个 thinking / tool_call / 工具组」之后的 trailing `text` 段**；这些保持可见。
- **过程 = 该回合内在此之前的 thinking、tool_call、explore/shell 工具组、以及夹在中间的中间陈述 `text`**（可含 error，见下）→ 折叠进 `Worked for`。
- **若整个回合没有任何 tool/thinking（纯问答）→ 不出 Worked for 行**，直接显示答案。

**始终保持可见（不折叠）：**
- 用户气泡（`user`）——回合起点。
- **To-dos 卡（`plan` kind）与 Plan 文档卡（`text` 且 `planDoc`）**——状态物/交付物，保持可见。
- 最终结论 trailing text。
- `turn_end` 统计行（`TurnStats`）。
- `system` 分割线（引擎切换 `⇄`、goal 公告等）。
- 建议 `error` 也保持可见（报错是重要结果，别折进去）。

**Worked for 的时长**：优先用该回合 `turn_end.durationMs`（与 Codex「整回合耗时」语义一致），用 `fmtDuration` 格式化；历史数据缺 durationMs 时可回退为「过程项时间戳跨度」。

**实现位置与做法**：`MessageList.tsx`。现有 `buildStream(messages)` 已把连续工具聚合成 `StreamItem[]`（`msg` | `tools` 组）。在其之上**再加一层按 turnId 的分组/包裹**：
1. 先算出「完成回合集合」= 有 turn_end 的 turnId。
2. 遍历 `StreamItem[]`，对每个 item 求其 turnId（`msg` 取 `msg.turnId`，`tools` 组取 `entries[0].turnId`）与角色（collapsed / pinned）。
   - `tools` 组 → collapsed。
   - `msg.kind === 'thinking'` → collapsed。
   - `msg.kind === 'tool_call'`（独立 edit/shell/task）→ collapsed。
   - `msg.kind === 'text'`：先判是否为该回合的 trailing text（回合内最后一个 thinking/tool/tools 组的位置之后）；trailing 或 `planDoc` → pinned；否则（中间陈述）→ collapsed。
   - `plan`（To-dos）/ `turn_end` / `system` / `error` / `user` → pinned。
3. 渲染：遇到某完成回合的**第一个 collapsed item** 时，收集该回合**全部 collapsed items**，渲染成一个 `<WorkedFor durationMs=... items=... />`（内部用 `Collapsible`，展开后按原方式渲染各 item：`tools` 组→`ToolGroup`，`thinking`→`ThinkingBlock`，text→markdown 等）；该回合后续 collapsed items 跳过（已并入）。pinned items 正常渲染。进行中回合的 item 一律走现状渲染。
4. `Worked for` 折叠行样式对齐现有 `ToolSummary`（`MessageList.tsx` line 270 附近）：一个图标（可用 `lucide` 的 `Clock` 或沿用现有风格）+ `Worked for {fmtDuration}` 文案 + 展开箭头，`text-ink-faint hover:text-ink-soft`。

> 关键：**过程→折叠的高度突变只发生一次且在回合边界**（turn_end 到达那一刻），与现有 ToolGroup「进行→折叠」一致，不会造成滚动跳动。切勿在流式中折叠。

**验收**：一个含思考+多次命令的已结束回合，过程坍缩成单行 `Worked for 1m 38s`，点击展开能看到原来的 `Thought for…`/`Explored…`/`Ran…` 明细；最终答案、To-dos 卡、TurnStats 仍直接可见；纯问答回合无 Worked for 行；进行中回合表现和现在完全一致；typecheck 通过。

---

### 任务 3：标题「更多」菜单重命名 + 超长用户消息折叠

**3a. 标题旁 ⋯ 菜单 → 重命名会话**
- 位置：`ChatView.tsx` header（line 273-280），当前只显示 `meta?.title` + cwd 徽章 + Heartbeat。在标题右侧放一个 ⋯ 按钮（参考 Codex 截图：标题后跟 ⋯，菜单里有 Rename chat）。
- 复用 `Sidebar.tsx` 的 `DotMenu`（line 910）交互范式；`DotMenu` 目前是 `Sidebar.tsx` 内部函数，建议**抽取为共享组件**（如 `src/renderer/src/components/DotMenu.tsx`）供两处复用；若嫌动静大，也可在 ChatView 内部实现一个等价小菜单，但**优先抽取**（符合"复用既有模式"约束）。
- 菜单项「重命名」的交互：点击后让 header 标题变为内联输入框（`autoFocus`，Enter 提交 / Esc 取消 / blur 提交），提交调用 `useChatStore.getState().renameSession(sessionId, newTitle)`（已实现，line 927）。空标题不提交。
- 本轮只要求「重命名」一项；如顺手可加「复制会话标题」等，但非必须。

**3b. 超长用户提问消息折叠（约 10 行）+ 展开**
- 位置：`MessageItem.tsx` 的 `UserBubble`（line 116-200），当前气泡内 `{msg.text}` 直接全量渲染。
- 目标：文本超过约 10 行时，默认 clamp 到 ~10 行 + 底部「展开」入口（Codex 同款）；点击展开全文，可再收起。
- 做法：用本地 `const [expanded, setExpanded] = useState(false)`；文本容器在未展开时加行数限高（可用 `line-clamp` 工具类，或 `max-height` + 底部渐隐遮罩，风格对齐 `PlanDocCard` 的限高渐隐 line 376-381）；仅当内容确实超高时才显示「展开/收起」按钮（可用 `scrollHeight > clientHeight` 检测，或简单按字符/换行数阈值）。按钮文案走 i18n（`expand`/`collapse`）。
- 注意：保留现有 hover 的「复制提问 / 回退到此处」按钮不受影响；选区 chip、附件行照旧。

**验收**：标题旁 ⋯ 菜单可重命名并即时生效（侧栏标题同步）；超长提问默认收起约 10 行、有展开/收起；短提问不出现展开按钮；typecheck 通过。

---

### 任务 4：Composer 加号（+）菜单

**用户明确要求**：引擎图标**保持最左侧不动**（"本次对话的根本"）；做一个 `+`，把**放大输入框**功能放进去；`+` 菜单里**还要有「选择文件」入口**。

**现状**：
- 控件条在 `Composer.tsx` line 564-629：左侧 `EngineBadge → ModeSwitch → PermissionPicker → SwarmToggle → RaceToggle → Goal`，右侧 `ModelPicker → EffortPicker → ContextRing → 放大(Maximize2, line 592-598) → 发送`。
- 放大功能：line 592-598 的按钮 `setExpanded(true)` → `ExpandDialog`（line 1793）。
- 附件目前仅拖拽/粘贴（`onDrop` line 392-438，`handleImagePaste` line 443）；无「+」、无文件选择器。

**实现要点**：
1. 新增 `AddMenu` 组件（或内联），按钮为 `lucide` `Plus`，**放在 `EngineBadge` 之后**（引擎仍是第一个）。用现有 `Dropdown`（line 1847）做弹层。
2. 菜单项两条：
   - **「放大输入框」**：`onClick={() => setExpanded(true)}`（复用现有 state 与 `ExpandDialog`）。**同时移除**右侧原独立的 `Maximize2` 按钮（line 592-598）。
   - **「选择文件」**：触发一个隐藏的 `<input type="file" multiple ref=... />`；`onChange` 里对每个 `File` 用 `window.cyberslots.getPathForFile(file)` 取绝对路径，然后**复用 `onDrop` 的分流逻辑**——图片（`IMAGE_RE`）→ `setAttachments`（`preview` 用 `URL.createObjectURL(file)`）；非图片 → `chipRef.current?.insertFileChip(name, path, false)`。建议把 `onDrop` 里处理 `File[]` 的那段抽成 `addFiles(files: File[])` 供拖拽与选择器共用。
3. `+` 按钮**不参与响应式退避**（现有 `level` 收缩逻辑 line 144-153；放大按钮注释说「永不退避」，`+` 承接了放大功能，同样不隐藏）。
4. 文案走 i18n：`addMenu`（按钮 title）、`expandInput`（已有 line 216）、`addFiles`（选择文件）。

**验收**：引擎仍在最左；其后有 `+`；`+` 菜单能放大输入框、能弹系统文件选择器并把选中文件加成附件（图片缩略图 / 非图片行内 chip）；右侧不再有独立放大按钮；typecheck 通过。

---

## 六、i18n 新增 key（zh + en 各一条）

在 `src/renderer/src/i18n.ts` 的 `zh` 与 `en` 字典各补齐（key 名仅供参考，可按现有命名风格微调；`expandInput` 已存在勿重复）：

| key | zh | en |
|---|---|---|
| `workedFor` | `工作用时` 或直接用 `Worked for`（可复用英文，Codex 原文即英文） | `Worked for` |
| `renameChat` | `重命名会话` | `Rename chat` |
| `expand` | `展开` | `Expand` |
| `collapse` | `收起` | `Collapse` |
| `addMenu` | `添加` | `Add` |
| `addFiles` | `选择文件…` | `Add files…` |
| `openFileInPanel`（可选，chip title） | `在面板中打开` | `Open in panel` |

> 备注：`Worked for` 保留英文与项目里 `Thought for`/`Explored`/`Ran` 等过程标签的英文风格一致，视觉更统一，推荐 zh/en 都用 `Worked for`。

---

## 七、验证清单（提交前逐条过）

- [ ] `npm run typecheck` 全绿（node + web 双配置）。
- [ ] `npm run dev` 手测四项功能（用户环境 Windows / PowerShell，命令用 `;` 分隔）。
- [ ] 任务1：文件 chip 有图标、点击开预览；常见非路径行内代码（`reasoning: true`/`status`/`chain_valid`）不误判。
- [ ] 任务2：已结束回合过程坍缩为 `Worked for`；展开还原明细；纯问答无该行；**进行中回合行为与现状零差异**（重点回归，别把活动窗/流式弄坏）。
- [ ] 任务3：⋯ 菜单重命名生效且侧栏同步；超长提问折叠+展开，短提问无按钮。
- [ ] 任务4：引擎最左；`+` 含放大+选择文件；右侧独立放大按钮已移除。
- [ ] 无任何通用 spinner/`animate-spin`/`animate-pulse` 表达 loading（若本轮引入了 loading，用 brand 组件）。
- [ ] 新文案 zh/en 双语齐全，无硬编码字符串。

---

## 八、已知坑 / 注意事项

1. **react-markdown 是 v9**：`code` 组件回调**没有 `inline` 参数**，必须用「className 是否含 `language-`」区分行内/块级。别照搬 v8 的 `inline` 写法。
2. **文件 chip 误判**：务必用「已知扩展名白名单」收紧 `looksLikeFilePath`，宁可漏判也别把普通行内代码（配置键、状态词）变成 chip。
3. **Worked for 只在回合边界折叠**：判定用「turnId 是否有 turn_end」，**不要**在流式过程中折叠，否则会破坏现有活动窗/滚动贴底体验，且造成频繁高度跳动。
4. **`pendingFilePreview` 信号消费顺序**：ChatView 只负责开 files tab（不清除），WorkspacePanel 负责打开文件并清除信号——保证「点击时 dock 未开」也能正确落地。
5. **sidechat 分支会话**：分支里点文件 chip 会写入以分支 sessionId 为 key 的信号，但分支面板内无独立 ChatView/dock 消费——属可接受的无害降级（chip 图标仍有价值）；若要严谨可在分支上下文禁用点击，非必须。
6. **DotMenu 抽取**：目前 `DotMenu` 在 `Sidebar.tsx` 内部；任务3 若抽成共享组件，注意 `Sidebar.tsx` 里对它及 `DotMenuItem`、`useEscClose` 的引用一并迁移/复用，别造成两份定义。
7. **AGENTS.md / .qoder/rules/brand-loading.md 同步**：本轮预计不改品牌规范；一旦改了 `brand.tsx` 或 loading 规范，两份文档必须同步更新。
8. 上一轮调查的完整现状清单（8 个问题维度）可在会话历史里找到；本文件已提炼出与本轮 4 个任务相关的全部结论。

---

_交接完成。建议按 任务1 → 任务2 → 任务3 → 任务4 顺序推进，每完成一个跑一次 typecheck。_
