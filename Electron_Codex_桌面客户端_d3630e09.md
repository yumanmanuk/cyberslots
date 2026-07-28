# CyberSlots（赛博老虎机）— 多引擎桌面 AI Agent 客户端 · 总指引

> 本文件是后续新对话的**唯一总指引**（as-built 版）：记录已定决策、已实现功能、关键实测结论、代码地图、遗留项与后续路线。
> 历史决策依据见 `d:\ai-agent\handoff.md`；阶段 0 实测报告见 `cyberslots/docs/phase0-findings.md`。
> 最后更新：2026-07-28 · 代码仓库 `d:\demo\cyberslots` · 最新 commit `9e765f4`
>
> 🆕 **2026-07-28 追加 2（opencode 第三引擎 + 内嵌终端 + 输入区改版）**：**opencode 引擎接入**（单例 serve + SSE 事件枢纽 + HTTP adapter，模型/凭据完全委托 opencode 自身，zen 免费模型免登录可用）· opencode 完整版模型选择器（搜索/收藏/最近/provider 分组/右侧详情浮出卡）· opencode 思考深度=模型级 reasoning variants · **右侧面板内嵌终端**（@lydell/node-pty 真 ConPTY + xterm，cwd=会话目录）· Composer 5 级响应式退避 · 输入框 2–5 行动态行高（无滚动条，sidechat 同步）· Ctrl+V 粘贴截图为图片附件（输入框内缩略图 + 点击放大灯箱）· 拖文件→光标处文件引用 chip（ChipInput contenteditable，复制/发送序列化为 `文件名(路径)`）· 文件树拖放导入 · 重启中断任务标 canceled+未读。
>
> 🆕 **2026-07-27 深夜追加（用户逐项体验后的功能完善，详见 §四已同步）**：多模型由 codex `model_catalog_json` 驱动（显示名/上下文窗口/输入模态/每模型思考深度档位）· 选中会话即预热引擎（取代惰性复活）· Plan 卡三态交互（卡片/预览收起/实施胶囊）· sidechat 可拖拽调宽 + 滑入动画 + 模型/思考深度选择· 会话行状态图标改版（右侧，蓝问号=待回答/红叹号=错/金点=未读）· 思考深度满档流光动画· 全局 Shift+Tab 切模式。
>
> 🆕 **2026-07-28 追加**：Goal 改为「模式开关」（点击只切模式、发送才提交；与 Plan 互斥）· 自动压缩阈值设置（默认 90%，回合边界触发）· 压缩过程/结果可见（工具行 + X→Y tokens）· **变更接受/回退功能**（变更面板列 AI 编辑文件+行数、单文件/全部 接受/回退、before/after diff、基线持久化跨重启、保留用户未提交手改）· 文件预览随 AI 编辑实时刷新 + 并发编辑冲突提示 · 多会话共编标识（N会话徽标+回退二次确认）· 回退底层升级为**影子 git 快照**（对标 opencode：write-tree 基线 hash / checkout 回退 / 不碰用户 .git）。
>
> ⚠ **2026-07-27 凌晨重大变更（本文尚未逐节同步，以下优先）**：详见 `cyberslots/docs/overnight-report.md`
> 1. **模型配置架构推倒重做**（用户指示）：App 不再存储任何 provider/密钥；设置-模型页 = `~/.codex` 与 `~/.kimi-code` 配置的**只读快照** + 每引擎一个**协议路由开关**（开=进程级注入内置转换 server；codex 用 `-c` 覆盖零写入，kimi 用镜像 home；关=CLI 完全直连自己配置）。ConfigWriter/safeStorage/presets/dev-seed 均已删除；AiServerHost 双前端（codex-server + openai-server）。新模块 `src/main/config/engineConfigs.ts`。
> 2. 用户 13 条测试意见全部落地（发送键/折叠浮出/sidechat 右侧只读分支面板/Project→Workspace/回合统计行/goal 完成小字/plan 缩略卡+md 预览/文件预览独立面板+高亮/思考深度滑条/上下文弹窗+100%确认/并发/通知修复），e2e 5 轮全过。
> 3. 关键新实测：kimi ACP 不推 usage_update（统计行用 ~ 估算）；codex 上下文占用必须用 tokenUsage.last 非 total；`codex -c` root 覆盖对 app-server 生效；用户 `~/.codex/auth.json` 是占位 key（codex 直连暂不可用，路由开着）。

---

## 一、项目速览

- 目标：Windows 桌面 AI Agent 客户端（Electron + React + TS + Tailwind，纯 JS/TS 不碰 Rust）
- 主引擎：kimi-code CLI（官方，经 ACP stdio 驱动，`@agentclientprotocol/sdk`）
- 副引擎：codex CLI（官方，经 app-server v2 ndjson JSON-RPC 驱动）
- 第三引擎：opencode CLI（官方，经 `opencode serve` HTTP + SSE 驱动；单常驻 server 按 `x-opencode-directory` 头路由多目录，模型/凭据完全委托 opencode 自身配置，本程序不做 provider 管理）
- 模型：用户自有 kimi token plan（kimi-for-coding）+ minimax token plan（MiniMax-M3），provider 已通用化可任意添加
- codex 的模型出口：内置 ai-server 代理（用户自有 responses↔chat 转换服务裁剪版，utilityProcess 托管）
- 视觉主身份：codex 桌面版风格（Notion 阅读米色为默认主题）+ 浅色 + 深色（Flexoki）
- 分发形态：免安装 zip 绿色版（数据落 exe 同级 `./data`）
- Git：`https://github.com/yumanmanuk/cyberslots.git`，本地 main 已有全部 commit，**push 需用户确认**

## 二、总体决策（已定，勿再讨论）

- 自建 Electron 壳（否决 fork AionUi：其引擎聚合在闭源 aioncore）
- codex 永远黑盒：只用官方二进制 + CODEX_HOME 配置 + app-server 协议，内核级需求转移 kimi 侧
- kimi CLI fork（your-kimi）**推迟**：目前全部用官方 CLI，fork 三项（toolModelRouter / 原生 session-fork / swarm 硬触发）留待阶段 5 按需
- 配置单一真源：用户只在设置页配端点+key（safeStorage 加密），ConfigWriter 自动分发到 kimi-home / codex-home / ai-server env（codex 拿不到真实 key）
- `usage_hint_text` 等 config.toml 提示词覆盖由用户自管，程序不碰

## 三、架构（as-built）

```
Renderer (React+Tailwind+zustand, i18n zh/en, 三态主题)
   ←IPC(typed, shared/ipc.ts)→ Main (Node)
        ├ SessionManager ── 会话生命周期/持久化/未读/通知/fork/steer/compact
        │    ├ KimiAdapter   → spawn `kimi acp`（ACP stdio）
        │    ├ CodexAdapter  → spawn `codex app-server`（ndjson JSON-RPC v2）
        │    └ OpencodeAdapter → 共享单例 `opencode serve`（HTTP REST + SSE 事件流）
        ├ OpencodeServerHost ── 懒启动单例 serve（自选空闲端口 + 随机 Basic 密码）
        ├ OpencodeEventHub ── 每 directory 一条 SSE，按 sessionID 分发到 adapter
        ├ TerminalService ── 每会话一个真 PTY（@lydell/node-pty ConPTY），面板内嵌终端后端
        ├ AiServerHost ── utilityProcess.fork(codex-server.js)，127.0.0.1 动态端口
        ├ ConfigWriter ── userData/kimi-home/config.toml + userData/codex-home/config.toml
        ├ CronService ── 定时任务（零依赖 cron 匹配器 + 无头会话）
        └ windowTheme ── 无边框标题栏随主题换色（titleBarOverlay）

  kimi acp  → 各 provider 官方端点直连（config.toml type=openai / openai_responses）
  codex     → 内置代理 →（模型名含协议路由：chat 槽走 responses↔chat 转换，responses 槽直通）
```

- 数据目录：dev 为 `%APPDATA%/cyberslots`，打包版为 exe 同级 `./data`
- 统一消息模型：`shared/types.ts` 的 `UnifiedMessage` / `EngineEvent`，引擎细节不越过 adapter 层

## 四、已实现功能清单（逐点，全部实测通过）

### 4.1 会话与侧栏
- 三段分类：Workspaces（多目录工作区）/ Projects（单目录，按 cwd 分组）/ Chats（纯聊天）
- 目录组头用文件夹开合图标（闭 Folder / 开 FolderOpen），不用旋转箭头
- Workspace 组头：git 徽标文件夹图标 + ×N 目录数
- 每个分组标题 hover 浮现 + 号：新建 Chat / 新建 Project 会话（弹目录选择）/ 新建工作区
- 每个 Workspace/Project 会话行 hover 右侧浮现 + 号：一键在该工作区/项目目录下开新会话
- Workspace 实体：命名 + 多文件夹（首目录为 cwd，其余目录经 contextSeed 前缀注入告知引擎）
- Workspace 管理菜单（···）：重命名 / 打开终端 / 在编辑器打开 / 从侧栏移除
- Project 组头菜单（···）：打开终端 / 在编辑器打开
- 会话行状态位（codex 风，统一在行尾）：运行中灰色转圈 / 等待回答蓝色问号（LLM 提问或待审批）/ 出错红色叹号 / 未读金色实心点（任务完成未查看）/ 空闲已读显相对时间；蓝色走主题化 `--info` token
- 删除二段确认：垃圾桶 → 红色对勾 → 再点才删，3 秒未确认自动恢复
- 筛选菜单（漏斗）：排序（更新时间/创建时间）+ 状态（全部/运行中/等待操作/出错/已完成）+ 仅未读 + 重置
- fork 分支树缩进展示（⑂ 前缀）；换引擎分支 ⇄ 前缀
- 未读机制：非活动会话回合完成标未读，选中即已读（main 持久化 + renderer 同步）
- 左下角：定时任务矩形入口 + 齿轮菜单（语言/主题快速切换 + 进入全页设置）

### 4.2 新会话页
- 引擎切换：Kimi Code / Codex / opencode
- 引擎品牌图标（EngineIcon，全局复用）：codex=OpenAI 结、kimi=K 字标，单色跟随 currentColor 适配明暗主题；opencode=官方块状光标（粗边框空心竖长方形，边框约占宽 1/4，铺满视窗高对齐 codex/kimi 视觉体量），固定金属银纵向渐变（上亮→中暗→下回光，#cfd2d6→#9aa0a8→#8f959d→#b7bbc1）不随主题变色，渐变 ID 用 useId 按实例隔离避免多处渲染冲突
- 三张卡：Chat（无目录）/ Project（选单目录）/ Workspace（弹多目录工作区创建，建完直接开会话）
- 已有 workspace 列表快捷开会话

### 4.3 对话流
- 流式 Markdown + thinking 折叠块 + 闪烁光标
- 工具调用卡片（read/edit/execute/fetch 状态四态 + 输出折叠）
- 审批底部卡（Approve once / Approve for session / Reject）+ AskUserQuestion 表单卡
- 任务清单 PlanWidget（sticky）
- 回合统计行：有真实 usage 显示 ↑上行（含缓存比）/ ↓下行 / t/s / 用时；无真实 usage（kimi ACP 不推 usage_update）时只显用时，不再展示 `~` 估算 token
- 消息持久化（debounce 写盘）+ 会话恢复：**选中会话即预热引擎**（sessionWarmUp IPC → ensureRuntime + ACP session/resume，取代“首条消息才惰性复活”），模型/思考深度/命令选择器立即就绪
- cron/steer 等 main 侧发起的消息经 `user.echo` 事件回显气泡
- **重启中断任务状态收敛**：运行态实时持久化（session.status 事件即写 meta）；重启后上次仍在执行/待回答的会话自动标**未读**（侧栏醒目提示半截任务）；被打断的进行中工具调用收敛为 **canceled**（灰色 ×，与真正的 failed 红色区分），未应答的权限/提问卡锁定；磁盘文件收敛后回写避免长期留存脏状态

### 4.4 Composer（输入区）
- 功能条布局（左→右）：引擎图标 → 模式（Agent/Plan）→ 权限 → ⚡Swarm → 🎯Goal ｜ 模型 → 思考深度（codex/opencode）→ 上下文圆环 → 展开 → 发送
- **5 级响应式退避**（控件条宽度收窄时按优先级依次退避，ResizeObserver 断点 730/650/560/470/400px）：①权限变图标 → ②隐思考深度 → ③隐模型名 → ④隐权限图标 → ⑤隐 Agent/Plan；引擎图标/放大输入框/发送按钮永不退避（Agent/Plan 隐藏后 Shift+Tab 仍可切模式）
- **输入框动态行高**：默认 2 行，Shift+Enter/粘贴多行时逐行增高，5 行封顶；永不显滚动条（`.no-scrollbar`）；无聚焦高亮边框（始终 border-line 暗边框）
- **ChipInput（contenteditable 输入框）**：拖入非图片文件 → 在光标处插入彩色文件引用胶囊 chip（`</> 文件名`样式）；Ctrl+C 复制/发送时 chip 序列化为纯文本 `文件名(绝对路径)`（拦截 copy/cut 按选区片段序列化）；纯文本粘贴去格式；保留 Enter 发送/Shift+Enter 换行/IME/空态占位符；chip 只由拖拽命令式插入不从字符串反解析（回填/清空为纯文本）
- Agent/Plan 分段切换 + **全局 Shift+Tab** 循环切换（window 级监听，焦点在任意处均生效，阻止默认焦点导航）
- Plan 模式：权限选择器隐藏（不再显示底部“只读规划”提示文字，避免切换时输入框上下跳动）
- 权限（Agent 下）：手动审批 / 全自动 / YOLO
- 引擎徽章点击 →「换引擎继续聊」：三引擎列表（排除当前引擎），历史重放式分支到另一引擎（contextSeed 注入）
- ⚡Swarm 开关：发送时注入 AgentSwarm 并行委派提示词
- 🎯Goal（仅 codex，模式开关式）：点图标只切换「目标编辑模式」（不立即提交，输入框占位变「输入目标…」），按发送/回车才把输入作为 objective 提交 codex `thread/goal/set`（等价其 `/goal`）；与 Plan **互斥**（进一方自动退另一方；codex 同款：plan 激活时隐藏 goal 状态条）
- Goal 状态条（输入框上方一行小字）：目标文本 + 执行计时 + 中止 / 继续 / 编辑（回填输入框并进目标模式）/ 清除目标（垃圾桶图标）
- 上下文圆环：发送按钮旁 SVG 圆环显示占用比例（>65% 黄 >85% 红），点击弹详情卡，确认后触发 compact（kimi 发 `/compact`，codex 调 `thread/compact/start`）；任务进行中点压缩给「本轮结束后再试」提示（不排队）
- 压缩可见化（codex）：压缩过程渲染为工具行「正在压缩上下文…→已压缩上下文」，完成后由下一次 tokenUsage 回填「已压缩上下文：X → Y tokens」（真实释放量）；压缩失败以 error 显性化、不再静默
- **图片附件**：拖拽或 **Ctrl+V 粘贴截图**（剪贴板原始图像→写 `userData/pasted/` 临时文件拿路径）→ 输入框**内部顶部 14×14 圆角缩略图**（object URL 预览，免读盘）；点击弹全屏**灯箱放大预览**（遮罩点击/Esc/右上角 × 关闭）；悬停缩略图右上角 × 移除；CSP img-src 含 blob:
- 非图片文件 chip（中性色 border-line + bg-panel，不抢眼）
- 展开按钮：长文输入大弹窗
- 思考深度选择器（codex/opencode 会话）：codex 档位取自当前模型 catalog 的 `supported_reasoning_levels`（缺省 low/medium/high/xhigh）；**opencode 档位 = 模型 reasoning variants 键名**（如 none/thinking、low/medium/high/max，无 variants 的模型自动隐藏控件；未显式选择时不下发 variant 跟随 server 默认）；滑条交互；拉满档（xhigh）时轨道金色流光 + 滑块脉冲光环 + 档位文字渐变流光动画（index.css `effort-max-*`）
- 模型选择器（右侧，与思考深度并排）：codex 候选来自 `model_catalog_json`（每项显示 displayName + 上下文窗口如 1M/256K + 图片模态图标），kimi 取 ACP 会话模型；**始终显示实际模型名**（无“默认”占位）；恢复态引擎未起时用持久化 modelId + catalog 兑底；切模型自动校正不支持的思考深度档；热切换（kimi unstable_setSessionModel；codex/opencode 下一 turn 生效）；opencode 用专属完整版选择器（见 §4.14）

### 4.5 发送队列与 steer
- 忙碌时发送 = 入队：发送位置出现专属入队按钮（ListPlus，accent 圆钮）+ 旁置停止按钮
- 新消息入队时队列头部条闪烁 accent 背景反馈（queue-bump 动画，面板常折叠时的可见确认）
- 队列面板（输入框上方，「等待发送 N」可折叠）：
  - 拖拽把手排序
  - 编辑（回填输入框并移出队列）
  - 删除
  - steer：codex 走原生 turn/steer 注入运行中回合；kimi 降级为插队到队首
- 回合结束后自动依次派发队首（出错时不派发）

### 4.6 执行心跳（网络中断可观察）
- 顶栏运行中显示：绿点脉冲「执行中」
- ≥12 秒无引擎事件：黄色「等待响应 Ns」
- ≥45 秒无事件：红色「疑似停滞 Ns」
- 数据源：任意引擎事件刷新 `ui.lastActivityAt`

### 4.7 右侧图标 rail（Work 会话）
- 文件（工程树 + 预览/编辑，写入有 workspace 边界检查）；预览随 AI 编辑/回退**实时重读盘刷新**；编辑态有未保存草稿且 AI 改了同一文件 → 顶部冲突提示条（加载 AI 版本 / 保留我的），保存或切文件后清除；**文件树支持拖放导入**（从资源管理器拖文件/文件夹进树 → 拷贝导入到工作区根目录并刷新；拖入时描边高亮 +「松开导入到 XXX」提示；fsImport IPC 递归拷贝，逐个尽力单个失败不阻断）
- 审查变更（**接受/回退**，保命级）：列出本会话 AI 编辑过的文件（M/A/D 徽标 + 真实 +/- 行数，主进程 ChangeTracker 台账驱动）；每行悬停 ✓接受（保留改动、停止跟踪）/ ↺回退（还原到编辑前）；头部「全部接受」/「全部回退」（回退全部两次点击确认）；点文件行开左侧 **before/after diff 对照**（LCS 红绿着色、双列行号，借鉴 claude-code StructuredDiff）
  - 基线机制（**影子 git 快照**，对标 opencode Snapshot）：每 root 一个独立 GIT_DIR（`userData/shadow-git/<hash>`）叠在工作树上，不碰用户 .git、非 git 目录也可用（自带 info/exclude 排除 node_modules 等 + 尊重工作树 .gitignore）；会话首个回合开始（AI 未动手）`add -A + write-tree` 拍**基线 tree hash**（含用户未提交手改，race-free）；回退 = `git checkout <hash> -- <file>`（不在快照=删新建）；行数/类型 = `git diff --cached --numstat/--name-status`；shell/命令改动无 fileChange 事件 → 回合结束快照 diff 扫尾补登记；台账仅持久化 `{baselineHash, touched[]}`（`userData/changes/<id>.json`，轻量非全文），**app 重启后仍可回退**
  - 多会话共编同一文件：各会话持自己的不可变基线 hash，回退互不打架；文件名旁黄色「N 会话」徽标提示；共编文件的单文件回退需**两次点击确认**（会影响所有会话）
- Agents（子代理活动卡片，按 title 前导动词匹配）
- **内嵌终端**（rail 终端图标）：点击在右侧面板内打开真 TTY 终端（不再开外部 PowerShell/cmd 窗口），cwd = 会话目录；后端 @lydell/node-pty 真 ConPTY（预编译 N-API 二进制，Electron 33 免 rebuild，无需本机编译器），前端 xterm.js + fit；支持颜色/光标定位/TUI(vim)/resize 同步；按会话 id 复用 PTY（切走再回仍同一终端）；终端主题读 CSS 变量跟随应用配色；app 退出全部 kill + orphanSweep 覆盖；打包 asarUnpack 原生 .node
- 开分支 sidechat（所有会话可用）
- 面板开着时底部有收起按钮

### 4.8 sidechat / 分支
- kimi：ACP `unstable_forkSession` 实测 **-32601 未实现** → 降级「新 session + 历史重放」（contextSeed 一次性前缀，12K 字符截尾）
- codex：原生 `thread/fork`
- 客户端复制消息文件，分支立即可见完整历史；打开即预热分支引擎（sessionWarmUp）
- 右侧面板宽度可拖拽调节（左缘把手，300–720px，localStorage 记忆）+ 打开滑入动画（panel-in）
- mini composer 底缘与主输入框纵向对齐；含模型选择器（同主 Composer 兜底逻辑）+ 思考深度滑条（复用主 EffortPicker，align=left，codex/opencode 会话显示）；输入框行高与主输入框一致（2 行起 5 行封顶、无滚动条）

### 4.9 定时任务（Cron）
- 左下角入口 → 管理模态：列表（启停开关 / cron 表达式徽章 / 立即运行 / 编辑 / 删除）+ 新建表单
- 5 段 cron 表达式（支持 `* , - /`），零依赖自写匹配器（`cronMatch.ts`，17 用例单测过）
- 保存时校验，非法表达式给中文错误
- 触发：无头新会话（⏰ 前缀标题）执行 prompt，完成/失败系统通知，记录上次运行时间与结果

### 4.10 设置（全页，按类别分栏）
- 通用：界面语言（简体中文/English 即时切换）/ 外观主题 / 发送键 / 自动压缩阈值（关闭 / 70/80/90/95%，默认 90%；占用达阈值时于回合边界自动压缩，绝不打断进行中回合）
- 模型：provider 通用化管理
  - 添加时从内置预设选择：Kimi For Coding / Moonshot 开放平台 / MiniMax 国内 / MiniMax 国际 / OpenAI / DeepSeek / 自定义
  - 预设自动带出 Base URL + 协议 + 建议模型
  - 每个 provider：名称可编辑 / 协议分段（Chat ↔ Responses）/ Base URL / API Key（掩码显示，回写保护）/ 模型行增删（别名 + 上游 ID + 上下文 K）
- 通知：任务完成 / 提问（审批与 AskUser）/ 报错 三开关（仅窗口未聚焦时发）
- 关于：版本信息
- 密钥 safeStorage（DPAPI）加密存储；renderer 只见掩码；掩码回写自动沿用旧密钥

### 4.11 主题与窗口
- 三态主题：Notion 阅读（默认米色）/ 浅色 / 深色（Flexoki）
- 无边框 titleBarOverlay：标题条与窗口控制按钮颜色随主题即时联动（`windowTheme.ts` + themeSync IPC）
- 顶部 40px 全局拖拽条
- 单实例锁；退出防孤儿（所有引擎子进程 + 代理 + cron 随 app 关闭）

### 4.12 引擎层
- KimiAdapter（ACP）：initialize / session new-resume / prompt（附件 resource_link）/ 取消 / 模型热切 / 权限模式 / 审批与 AskUserQuestion 桥 / think 标签拆分 / usage / slash 命令透传 / compact(`/compact`)
- CodexAdapter（app-server v2）：thread start/resume/fork / turn start-interrupt-steer / item 事件映射（agentMessage、reasoning、commandExecution、fileChange、mcpToolCall、webSearch、collab）/ 审批 server-request 应答 / plan / tokenUsage / effort / compact / 权限模式映射（default=on-request+workspace-write，plan=read-only，auto=never，yolo=danger-full-access）
- OpencodeAdapter（HTTP + SSE，详见 §4.14）：共享单例 serve；session create/resume（服务端持久化直接续接）/ prompt（逐条带 model+agent+variant，**只以 SSE `session.idle` resolve 回合**，HTTP 响应仅作错误通道）/ abort / 原生 fork(`/session/{id}/fork`) / compact(summarize) / 权限模式映射（default→build agent，plan→plan agent，auto/yolo→build + adapter 自动应答权限 once/always 不弹窗）；SSE part 全量快照→自算增量 delta；steer/goal 不实现（UI 自动隐藏，opencode 无原生 steer，官方 CLI 也是串行队列）
- 内置 ai-server：resources/ai-server（上游 codex-server.js 原样 + config.js env shim），启动时复制到 userData 运行，key 只经 env 不落盘，仅 loopback 白名单，quota-guard 等团队功能关闭
- 协议自动路由：第一个 `openai_chat` provider 喂转换槽（KIMI_*），第一个 `openai_responses` provider 喂直通槽（MINIMAX_*）
- 多模型目录：codex `config.toml` 的 `model_catalog_json` 声明的 JSON（相对路径相对 CODEX_HOME），`engineConfigs.ts` 解析出每个模型的 slug（=codex `model` 参数）/ displayName / context_window / input_modalities / supported_reasoning_levels；`visibility:hidden` 跳过；直连模式候选 = 目录全部 slug（无目录回退 config 默认 model）；启动时读一次，改目录需重启应用
- kimi config.toml `type` 映射：openai_chat→`openai`，openai_responses→`openai_responses`（双协议均实测可用）

### 4.13 打包
- `npm run dist` → `dist/CyberSlots-0.1.0-win-x64.zip`（约 110MB，免安装）
- electron-builder：zip target + ai-server extraResources + `signAndEditExecutable: false`（规避 winCodeSign symlink 权限问题）+ `asarUnpack: **/@lydell/node-pty*/**`（内嵌终端原生 .node 必须解包才能 dlopen）
- 打包版数据目录重定向 exe 同级 `./data`（app ready 前 setPath）

### 4.14 opencode 引擎（第三引擎，HTTP + SSE）
- **接入形态**：全部 opencode 会话共享一个懒启动单例 `opencode serve`（opencode 官方设计即单实例按请求 `x-opencode-directory` 头路由多目录）；不连接外部已运行实例
- **OpencodeServerHost**：主进程自选空闲端口显式传入（不用 `--port 0` 的 4096 优先语义，避免与用户自跑的 opencode 抢端口）；每次启动随机生成 `OPENCODE_SERVER_PASSWORD` 注入 env，全部请求带 Basic 鉴权头（serve 不设密码时 127.0.0.1 无鉴权，本机任意进程可驱动）；stdout 就绪行解析 + `/global/health` 双确认；进程退出走「error 态 + 下次操作懒重启」（不做周期健康守护）；PID 入 orphanSweep
- **OpencodeEventHub**：每 directory 一条上游 SSE `/event`，按事件 properties.sessionID 分发到各 adapter；断线 250ms 退避重连 + 20s stall 看门狗；引用计数归零关连接
- **崩溃恢复**：opencode 会话服务端持久化，engineSessionId 重启后续接；手杀 server → 会话报错 → 再发消息 ensureLive 自动重启续接；空闲时停机（如强制刷新重启 serve）只转 closed 懒唤醒态不报红错；回合中停机才报错并结束等待防队列卡死
- **模型/凭据哲学（用户已拍板）**：本程序**不做任何 provider 连接/管理**；模型目录只消费 `GET /config/providers`（= 已连接+启用的可用集：zen 免费模型**免登录开箱即用**、opencode.json 自定义模型、已 `opencode auth login` 的 provider；绝不用 `/provider` 的 models.dev 全目录）；新增 provider 引导用户去 opencode CLI 操作
- **完整版模型选择器**（OpencodeModelPicker，opencode 会话专属）：搜索框 + 收藏星标（localStorage）+ 最近使用（localStorage，最多 5）+ 按 provider 分组 + 免费标签 + 上下文窗口/图片模态图标；**详情卡从弹层右侧浮出**（hover/当前模型：能力 Tool calling/Reasoning/附件、输入→输出模态、$/1M 价格、上下文、思考档位）；底部静态引导「连接更多 provider：终端运行 opencode auth login」；**刷新按钮 ↻ = 重启 serve 再拉目录**（opencode 无配置文件 watcher，运行中实例握旧快照，改 opencode.json 后仅重拉无效）
- **模型 id 规范**：复合 slug `providerID/modelID`；跨引擎 fork 继承的无 `/` 旧别名判无效强制重置（首选 zen 免费模型），防止 prompt 不带 model 时 server 静默用自己默认模型
- **catalog IPC**：新增 `opencodeCatalogGet` 通道，主进程代理 /config/providers（renderer 不直连 serve 端口，server 密码不出主进程）；按 server 代次缓存
- **设置页 opencode 只读区块**：CLI 安装状态/版本、opencode.json 存在性、已连接 provider 列表（手动加载按钮，不被动启动 server）+ 引导文案；无路由开关（opencode 不经 ai-server 协议代理）
- **sidechat**：opencode 复用 kimi 同款 SIDECHAT_GUARD 只读指令前缀软约束（plan agent 会写计划文件，无 read-only 硬隔离）
- **探针**：`scripts/probe-opencode.mjs` 全链路契约实测（端点/SSE 事件枚举/permission 应答/fork/resume，1.17.18 验证通过）；依赖 `@opencode-ai/sdk@^1.18.5`（与 openchamber 同版，仅作类型参考，实现走裸 fetch 按探针实测的 legacy 端点）

## 五、关键实测结论（新对话必读的坑）

- kimi CLI 0.29.1 ACP：sessionCapabilities 仅 `{list, resume}`；`session/fork` 返回 -32601（SDK 有方法 ≠ agent 实现）；探针脚本 `scripts/probe-fork.mjs`
- kimi spawn 方式：PowerShell 执行策略拦 .ps1 shim，必须 `node <APPDATA>/npm/node_modules/@moonshot-ai/kimi-code/dist/main.mjs acp`（resolveKimi.ts 已封装；codex 同理 `@openai/codex/bin/codex.js`）
- 子进程用 `process.execPath + ELECTRON_RUN_AS_NODE=1`，dev/打包通用
- codex app-server 帧：ndjson、**无 `jsonrpc:"2.0"` 字段**；先 `initialize` 后必须发 `initialized` 通知
- codex wire_api 只剩 `responses`（chat 已删）→ 内置代理是必经之路；自定义 provider 无需登录（requiresOpenaiAuth=false）
- codex turnId 是字符串，客户端自增 int 做映射；turn/start 响应即返回，完成以 `turn/completed` 通知为准
- MiniMax `<think>` 内联在 content：KimiAdapter 的 ThinkSplitter 已处理
- kimi coding plan 端点（api.kimi.com/coding）有 UA 白名单：ConfigWriter 自动注入 claude-cli UA
- zustand v5 selector 禁止内联 `?? []` / map / filter（返回新引用 → useSyncExternalStore 无限循环白屏）；用模块级 EMPTY_XXX 常量兜底
- kimi setSessionMode 不总回推 current_mode_update：store.setMode 已做乐观更新
- 主项目 package.json `type: "module"`：内嵌 CJS 资产（ai-server）需自带 `{"type":"commonjs"}` 的 package.json
- electron-builder 打包需 `signAndEditExecutable: false`，否则 winCodeSign 缓存解压 symlink 失败
- dev 时若 5173 被占用说明有旧 dev server 残留，杀掉 electron.exe 重启（旧实例会导致改动不生效的假象）
- **opencode 实测坑（2026-07-28，本机 CLI 1.17.18）**：
  - 回合结束唯一可靠信号 = SSE `session.idle`（POST message 的 HTTP 响应也会阻塞到完成但只作错误通道，错误顺序实测 session.error → idle）；`message.part.updated` 是**全量快照非增量**（按 partID 记已发长度自算 delta）；用户消息也推 part 事件（按 message role 过滤 echo）
  - `GET /config/providers` = 已连接可用集（handler 调 Provider.list，OpenAPI summary 字面误导）；zen 免费模型无凭据时以 public key 自动加载**免登录可用**；openchamber 选择器同源，`/provider` 全目录仅其 Add-provider 管理页用
  - `--port 0` ≠ 随机端口（优先抢 4096）；未设 OPENCODE_SERVER_PASSWORD 时 serve 无鉴权；permission 应答 legacy 端点 `POST /session/{id}/permissions/{permissionID}` body `{response: once|always|reject}`；事件 `permission.updated`（Permission 对象）/`permission.replied`
  - opencode server **无配置文件 watcher**：改 opencode.json 后运行中实例握旧快照，必须重启 serve 才生效（仅 PATCH /config API 会触发实例重建）
  - 思考档位 = 模型级 reasoning variants：自定义 provider 模型需在 opencode.json 模型条目加 `"reasoning": true` 才生成档位；且 id 含 kimi/minimax/qwen/glm 等关键词的模型被 transform 源码显式排除（MiniMax-M3 特判例外 [none,thinking]）
- **node-pty 实测坑**：本机无 VS 编译工具链，官方 node-pty 源码编译必败；`@lydell/node-pty` 预编译分支是 **N-API 二进制**（napi_register_module_v1），ABI 稳定，Electron 33 免 rebuild 直接加载（已验证 spawn ConPTY 正常）
- **Electron 文件拖放**：必须在 window 级 preventDefault dragover/drop（否则拖文件导航到 file:// 且子元素 drop 不稳定触发）；Windows 下 dragover 还需显式设 `dataTransfer.dropEffect='copy'`
- **Tailwind CSS 变量色**：`err: 'var(--err)'` 字符串定义不支持 `/30` 透明度修饰符（类静默不生成退白边框）；withAlpha 函数式定义只在纯数字透明度时生成静态 color-mix，普通类保持原样 var()（卷入 --tw-*-opacity 变量 calc 会让全部边框退白）

## 六、代码地图

```
cyberslots/
├ src/shared/          types.ts(统一模型/设置/事件) ipc.ts(通道契约) presets.ts(provider预设)
├ src/main/
│  ├ index.ts          入口：portable data 重定向、窗口(titleBarOverlay)、单实例、防孤儿
│  ├ windowTheme.ts    主题→原生窗口颜色
│  ├ ipc.ts            IPC 注册（薄胶水，key 掩码在此）
│  ├ config/settings.ts    SettingsStore（safeStorage、迁移、dev seed .dev/secrets.json）
│  ├ config/ConfigWriter.ts kimi-home + codex-home 的 config.toml 生成
│  ├ engine/EngineAdapter.ts 引擎接口（prompt/cancel/setModel/setMode/fork?/compact?/steer?）
│  ├ engine/SessionManager.ts 会话中枢（fork/forkToEngine/steer/compact/markRead/通知/contextSeed）
│  ├ engine/changeTracker.ts + shadowGit.ts 变更台账与影子 git 快照（接受·回退）
│  ├ engine/kimi/       KimiAdapter.ts resolveKimi.ts thinkSplitter.ts
│  ├ engine/codex/      CodexAdapter.ts rpc.ts(ndjson-rpc) resolveCodex.ts
│  ├ engine/opencode/   OpencodeAdapter.ts OpencodeServerHost.ts OpencodeEventHub.ts resolveOpencode.ts
│  ├ terminal/TerminalService.ts 内嵌终端后端（@lydell/node-pty 真 PTY，按会话复用）
│  ├ proxy/AiServerHost.ts 内置代理托管（utilityProcess、动态端口、协议槽位）
│  ├ cron/              CronService.ts cronMatch.ts
│  └ fs/fsService.ts    工程树/预览/写入(边界检查)/git状态/openIn/拖放导入(importPaths)/粘贴图临时文件(saveTempAttachment)
├ src/renderer/src/
│  ├ i18n.ts            zh/en 字典 + useT()
│  ├ store/chatStore.ts 唯一状态源（事件折叠/队列/goal/effort/筛选/心跳/opencodeCatalog 懒加载）
│  └ components/        App Sidebar NewSessionView ChatView(含rail+心跳) Composer(功能区全家桶)
│                       ChipInput(contenteditable+文件chip) OpencodeModelPicker(完整版选择器)
│                       TerminalPanel(xterm内嵌终端) MessageItem PermissionSheet PlanWidget
│                       SettingsView(全页) ScheduledView WorkspaceDialog ErrorBoundary
│                       workspace/(Panel FileTree(拖放导入) FilePreview DiffView)
├ resources/ai-server/  内嵌代理（上游原样 + config.js shim + package.json CJS 标记）
├ scripts/              phase0-verify.mjs probe-fork.mjs probe-endpoints.mjs probe-opencode.mjs 等探针
├ docs/phase0-findings.md
└ electron-builder.yml
```

- 常用命令：`npm run dev`（watch）/ `npm run typecheck` / `npm run pack:dir` / `npm run dist`
- dev 密钥：`.dev/secrets.json`（gitignored，改动后自动重播种 providers）

## 七、执行纪律（用户规矩，必须遵守）

- 阶段门禁：写码 → typecheck → 运行验证（ComputerUse 真机实测）→ commit → 下一步
- 三思而后行；代码优雅、模块化、易维护、可拓展、零隐藏 bug；「只给一次机会，要一次跑通」
- 本地 commit 自动做，push 需用户确认
- 圆角体系：模态 rounded-2xl / 卡片面板 rounded-xl / 按钮输入 rounded-lg / 小件 rounded-md；阴影：模态 2xl / 下拉 lg / 卡片 sm；交互都带 transition
- 新增用户可见文案必须进 i18n 字典（zh + en 两份）
- UI 疑问随时问用户，无疑问自动执行不停顿

## 八、已知遗留小项（下轮顺手修）

- English 下 Composer 权限选择器（手动审批/全自动/YOLO）未入 i18n 字典
- 右侧 rail 图标在面板开/收时垂直位置轻微偏移（收起按钮占位），可改固定占位
- kimi「Approve for this session」对同回合并发的第二个同名授权不生效（引擎侧行为）——可选做客户端侧会话内自动批准记忆
- Goal 状态与队列为内存态，应用重启丢失（可选持久化）
- ScheduledView 删除任务无二次确认（可复用侧栏二段确认模式）
- 打包版无应用图标、未签名（杀软误报风险，后期项）
- 旧会话（消息持久化功能之前创建的）历史为空，属历史数据非 bug

## 九、后续路线（未做，按优先级）

### P1 待做
- （✅ 已完成）diff 查看器 + 文件变更逐个/全部 接受·回退 — 见 §4.7
- @ 文件补全、slash 命令菜单（commands.update 事件已透传，UI 未做）
- 会话搜索（sqlite FTS 或简单全文）、导出 Markdown、会话重命名/置顶 UI（置顶字段已有）
- MCP 统一管理页（双引擎 config 同步）
- CLI 路径设置项（cliEntry 参数 adapter 已支持，设置页未暴露）
- 托盘、开机自启、全局快捷键、窗口记位、electron-updater

### P2 待做
- swarm 进度面板增强（模型/token/耗时列；依赖引擎事件面，可能需 fork）
- 成本仪表盘（usage 事件已有 costUsd 字段）
- 执行过程时间线
- 回退提问（codex thread/rollback 已弃用改用 fork+lastTurnId；kimi 走客户端重放）

### 阶段 5：your-kimi fork（按需启动，用户确认后才做）
- toolModelRouter：按工具类型路由 subagent 模型（读类→小模型，写类→主模型）+ 规则表 UI + 决策日志
- acp-adapter 补 session/fork 原生实现（替换现在的历史重放降级）
- swarm.run 硬触发接口
- fork 改动集中三个独立模块，rebase 冲突面小

## 十、验证方式

- 运行验证统一用 ComputerUse 子代理真机操作 dev 窗口（electron.exe），要求逐项截图 + 异常逐字记录
- 协议级疑问先写探针脚本定案（scripts/ 下已有范例），不要靠猜
- E2E 涉及真实模型调用：MiniMax-M3 与 kimi-for-coding 均已验证可用（key 在 .dev/secrets.json）
- 引擎测试注意：kimi 回复可能 20 秒内完成，测队列/steer 需用长任务（如写多文件）
