# CyberSlots（赛博老虎机）— 双引擎桌面 AI Agent 客户端 · 总指引

> 本文件是后续新对话的**唯一总指引**（as-built 版）：记录已定决策、已实现功能、关键实测结论、代码地图、遗留项与后续路线。
> 历史决策依据见 `d:\ai-agent\handoff.md`；阶段 0 实测报告见 `cyberslots/docs/phase0-findings.md`。
> 最后更新：2026-07-27 深夜 · 代码仓库 `d:\ai-agent\cyberslots` · 最新 commit `b83f501`
>
> 🆕 **2026-07-27 深夜追加（用户逐项体验后的功能完善，详见 §四已同步）**：多模型由 codex `model_catalog_json` 驱动（显示名/上下文窗口/输入模态/每模型思考深度档位）· 选中会话即预热引擎（取代惰性复活）· Plan 卡三态交互（卡片/预览收起/实施胶囊）· sidechat 可拖拽调宽 + 滑入动画 + 模型/思考深度选择· 会话行状态图标改版（右侧，蓝问号=待回答/红叹号=错/金点=未读）· 思考深度满档流光动画· 全局 Shift+Tab 切模式。
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
        │    └ CodexAdapter  → spawn `codex app-server`（ndjson JSON-RPC v2）
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
- 引擎切换：Kimi Code / Codex
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

### 4.4 Composer（输入区）
- 功能条布局（左→右）：引擎图标 → 模式（Agent/Plan）→ 权限 → ⚡Swarm → 🎯Goal ｜ 模型 → 思考深度（codex）→ 上下文圆环 → 展开 → 发送
- Agent/Plan 分段切换 + **全局 Shift+Tab** 循环切换（window 级监听，焦点在任意处均生效，阻止默认焦点导航）
- Plan 模式：权限选择器隐藏（不再显示底部“只读规划”提示文字，避免切换时输入框上下跳动）
- 权限（Agent 下）：手动审批 / 全自动 / YOLO
- 引擎徽章点击 →「换引擎继续聊」：历史重放式分支到另一引擎（contextSeed 注入）
- ⚡Swarm 开关：发送时注入 AgentSwarm 并行委派提示词
- 🎯Goal：**输入框内容即目标**，点图标触发（无弹窗）；已有 goal 时再点 = UpdateGoal
- Goal 状态条（输入框上方一行小字）：目标文本 + 执行计时 + 中止 / 继续 / 编辑（回填输入框）/ 删除
- 上下文圆环：发送按钮旁 SVG 圆环显示占用比例（>65% 黄 >85% 红），点击弹详情卡，确认后触发 compact（kimi 发 `/compact`，codex 调 `thread/compact/start`）
- 附件：拖拽文件 → 文件 chip 在输入框内、图片 chip 在输入框顶部，可单个移除（webUtils.getPathForFile 取绝对路径）
- 展开按钮：长文输入大弹窗
- 思考深度选择器（仅 codex 会话）：档位取自当前模型 catalog 的 `supported_reasoning_levels`（缺省 low/medium/high/xhigh），滑条交互；拉满档（xhigh）时轨道金色流光 + 滑块脉冲光环 + 档位文字渐变流光动画（index.css `effort-max-*`）
- 模型选择器（右侧，与思考深度并排）：codex 候选来自 `model_catalog_json`（每项显示 displayName + 上下文窗口如 1M/256K + 图片模态图标），kimi 取 ACP 会话模型；**始终显示实际模型名**（无“默认”占位）；恢复态引擎未起时用持久化 modelId + catalog 兜底；切模型自动校正不支持的思考深度档；热切换（kimi unstable_setSessionModel；codex 下一 turn 生效）

### 4.5 发送队列与 steer
- 忙碌时发送 = 入队：发送位置出现专属入队按钮（ListPlus，accent 圆钮）+ 旁置停止按钮
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
- 文件（工程树 + 预览/编辑，写入有 workspace 边界检查）
- 审查变更（按文件聚合 +/- 与已写入标记，兼容 diff 与 title-verb 两种来源）
- Agents（子代理活动卡片，按 title 前导动词匹配）
- 在此目录打开终端（wt 优先，降级 PowerShell）
- 开分支 sidechat（所有会话可用）
- 面板开着时底部有收起按钮

### 4.8 sidechat / 分支
- kimi：ACP `unstable_forkSession` 实测 **-32601 未实现** → 降级「新 session + 历史重放」（contextSeed 一次性前缀，12K 字符截尾）
- codex：原生 `thread/fork`
- 客户端复制消息文件，分支立即可见完整历史；打开即预热分支引擎（sessionWarmUp）
- 右侧面板宽度可拖拽调节（左缘把手，300–720px，localStorage 记忆）+ 打开滑入动画（panel-in）
- mini composer 底缘与主输入框纵向对齐；含模型选择器（同主 Composer 兜底逻辑）+ 思考深度滑条（复用主 EffortPicker，align=left）

### 4.9 定时任务（Cron）
- 左下角入口 → 管理模态：列表（启停开关 / cron 表达式徽章 / 立即运行 / 编辑 / 删除）+ 新建表单
- 5 段 cron 表达式（支持 `* , - /`），零依赖自写匹配器（`cronMatch.ts`，17 用例单测过）
- 保存时校验，非法表达式给中文错误
- 触发：无头新会话（⏰ 前缀标题）执行 prompt，完成/失败系统通知，记录上次运行时间与结果

### 4.10 设置（全页，按类别分栏）
- 通用：界面语言（简体中文/English 即时切换）/ 外观主题 / 发送键 / 默认模型
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
- 内置 ai-server：resources/ai-server（上游 codex-server.js 原样 + config.js env shim），启动时复制到 userData 运行，key 只经 env 不落盘，仅 loopback 白名单，quota-guard 等团队功能关闭
- 协议自动路由：第一个 `openai_chat` provider 喂转换槽（KIMI_*），第一个 `openai_responses` provider 喂直通槽（MINIMAX_*）
- 多模型目录：codex `config.toml` 的 `model_catalog_json` 声明的 JSON（相对路径相对 CODEX_HOME），`engineConfigs.ts` 解析出每个模型的 slug（=codex `model` 参数）/ displayName / context_window / input_modalities / supported_reasoning_levels；`visibility:hidden` 跳过；直连模式候选 = 目录全部 slug（无目录回退 config 默认 model）；启动时读一次，改目录需重启应用
- kimi config.toml `type` 映射：openai_chat→`openai`，openai_responses→`openai_responses`（双协议均实测可用）

### 4.13 打包
- `npm run dist` → `dist/CyberSlots-0.1.0-win-x64.zip`（约 110MB，免安装）
- electron-builder：zip target + ai-server extraResources + `signAndEditExecutable: false`（规避 winCodeSign symlink 权限问题）
- 打包版数据目录重定向 exe 同级 `./data`（app ready 前 setPath）

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
│  ├ engine/kimi/       KimiAdapter.ts resolveKimi.ts thinkSplitter.ts
│  ├ engine/codex/      CodexAdapter.ts rpc.ts(ndjson-rpc) resolveCodex.ts
│  ├ proxy/AiServerHost.ts 内置代理托管（utilityProcess、动态端口、协议槽位）
│  ├ cron/              CronService.ts cronMatch.ts
│  └ fs/fsService.ts    工程树/预览/写入(边界检查)/git状态/openIn(含 terminal)
├ src/renderer/src/
│  ├ i18n.ts            zh/en 字典 + useT()
│  ├ store/chatStore.ts 唯一状态源（事件折叠/队列/goal/effort/筛选/心跳）
│  └ components/        App Sidebar NewSessionView ChatView(含rail+心跳) Composer(功能区全家桶)
│                       MessageItem PermissionSheet PlanWidget SettingsView(全页) ScheduledView
│                       WorkspaceDialog ErrorBoundary workspace/(Panel FileTree FilePreview)
├ resources/ai-server/  内嵌代理（上游原样 + config.js shim + package.json CJS 标记）
├ scripts/              phase0-verify.mjs probe-fork.mjs probe-endpoints.mjs 等探针
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
- diff 查看器（stacked/inline + 增删行数；数据源 codex turn/diff/updated 已有事件、kimi tool diff content）
- 文件变更逐个接受/拒绝（codex FileChangeApprovalDecision 已接，UI 未做粒度操作）
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
