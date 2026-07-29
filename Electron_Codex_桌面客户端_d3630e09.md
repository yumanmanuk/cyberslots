# CyberSlots（赛博老虎机）— 多引擎桌面 AI Agent 客户端 · 总指引

> 本文件是后续新对话的**唯一总指引**（as-built 版）：记录已定决策、已实现功能、关键实测结论、代码地图、遗留项与后续路线。
> 历史决策依据见 `d:\ai-agent\handoff.md`；阶段 0 实测报告见 `cyberslots/docs/phase0-findings.md`。
> 最后更新：2026-07-29 · 代码仓库 `d:\demo\cyberslots` · 最新 commit `8129fec`
>
> 🆕 **2026-07-29 追加（大模型赛马 —— 竞争式规划工作流，本轮主体功能，详见 §4.20）**：双/三选手盲跑并行规划 → 三段式交叉反驳（⚔反驳/🤝吸纳/🛡辩护，方案冻结）→ 裁判两道人工关口（采纳策略前置 4/6 选 1 + 评语 → 三段式出方案含**设计溯源表** → 批注修订循环）→ 唯一写盘执行者 → 独立审计 VERDICT → 有界修复回环（≤3）· 赛马**寄生于宿主对话**（⚔ 入口按会话过滤/直入、可携带对话摘录作选手背景、角色会话侧栏隐藏、发起/剔除/收尾公告回流宿主）· 设置→赛马页（各角色默认引擎/模型/思考档 + 第三选手开关）· 全套容错：瞬时错自动重试、单选手 ■中止/↻精准重试（逐选手产物落盘、只补跑缺失方）、⚙调参即自动重跑、✂剔除选手（三人场二段确认、标记式不删数据）、↩重选策略/重跑规划、重启恢复（interrupted+手动继续）· 交卷判定 = 静默收敛（兼容 codex 内部多回合）· 泳道复用主区 MessageList（隐藏 token 统计行/回退钮/实施钮，Plan 卡弹窗预览）· 全阶段整页锁滚。
>
> 🆕 **2026-07-29 追加（消息流进行态渲染重构，Claude Code/Qoder 风，详见 §4.3 / §4.11）**：思考块去矩形（🧠 + "Thinking" 流光，正文限高 8 行自动滚底，结束自动折叠 "Thought for Ns"；opencode 用 reasoning part.time 真实思考时长回填，修 SSE 突发送达时墙钟严重偏小）· 连续同类工具聚合可折叠组：Explore 组（Exploring 明细流 → Explored N files · M searches）与 Shell 组（Running 命令卡流 → Ran N commands · M failed），思考段并入组内不切断分组 · 编辑卡右侧 +N -N 行数与 A/M/D 徽章（opencode filediff metadata）+ 文件类型品牌色图标（FileTypeIcon）+ 进行中卡面扫光 "Generating…" + 逐行着色 diff · shell 命令条右侧 Running…/Ran/Exit N/Failed + 实时输出追底 · 内联 To-dos 卡片（N/M done，完成灰圈勾不划线）· 删除黄色打字 caret，底部活动指示器 = 旋转 ✳ + "Working…" 流光、仅静默空窗期显示（各块自带进行态标签不重复）· 按钮 hover 全局统一背景色、废除悬浮 accent 边框（用户拍板：黄边框难看；推翻同日早前「悬浮描边品牌化」决策，详见 §4.11）。
>
> 🆕 **2026-07-29 追加（sidechat 秒开 + dock 开合动画，详见 §4.7 / §4.8）**：新建 sidechat 分支改为**乐观打开**——点击立刻弹「分支创建中…」占位 tab（fork/引擎唤醒转后台，完成后原地替换为真实面板，占位宽度对齐真实面板不跳动；用户中途切走不强制跳回），不再干等 loading · 悬停 rail sidechat 钮即**预热父引擎**（sessionWarmUp，fork 免等唤醒）· 右侧 dock 开合新增 **DockReveal 宽度过渡**（grid 列 0fr↔1fr 插值 220ms，dock 从右缘滑入/滑出的同时中间消息区同步平滑让位而非瞬移，收起等过渡结束再卸载子树），sidechat/plan 旧有面板级滑入动画统一收敛到 dock 层。
>
> 🆕 **2026-07-29 追加（Goal 体验完善 + codex 自发回合收尾约定，详见 §4.4 / §4.12）**：Goal 提交即**乐观显示状态条**（thread/goal/set 往返与懒启动期间不空窗，失败回滚并在消息流显性化报错）· Goal **计时连续显示**（引擎只在结算点推 timeUsedSeconds，两次推送间本地秒级外推 + 单调保护不回跳，暂停定格）· Goal **完成公告推迟到回合收尾后插入**（codex 模型先调 update_goal 标完成再流出收尾总结，公告不再插队在最终输出之前）· 权限模式切换经 `thread/settings/update` **热同步线程存量策略**（goal 续跑等引擎自发回合即时生效，如切 YOLO 后续跑不再按旧策略弹授权）· codex **引擎自发回合（goal continuation / compact / review）补全生命周期**：turn.started + running 推进、`stopReason='background'` 收尾恢复 idle（消费方按此过滤：无统计行 / 不派发队列 / 不触自动压缩 / 不弹完成通知 / 赛马不误交卷），授权应答后状态必回 running/idle · 待办行条收起态**只显进度 n/m**、不再展示当前任务文本。
>
> 🆕 **2026-07-29 追加（提问级回退 Undo to prompt，详见 §4.19）**：用户气泡 hover 左侧浮现「回退到此处」→ Confirm Undo 弹窗列出将被一并撤销的文件变更（A/M/D + 绿 +N 红 -M + 多会话共编黄色徽标）→ 确认后：磁盘文件还原到该提问发送前的影子快照、该提问及其后所有消息移除（先全量备份 `.undo-bak.json`）、引擎上下文重置（清 engineSessionId + 截断后历史作 contextSeed 下次发送新建引擎会话续接，三引擎行为一致）、原提问自动回填输入框可改后重发；该提问后无代码变更/无快照时弹窗给降级说明、确认仅移除消息+回填；快照 = 每次 prompt 前 ShadowGit 拍 tree hash 按用户消息 id 入台账（100 条滚动、跨重启可用）；steer / Sent as goal / 赛马角色会话 / 会话忙碌时不提供回退。
>
> 🆕 **2026-07-29 追加（opencode 模型展示管理 + 设置页全量实时保存，详见 §4.10 / §4.14）**：设置 → 模型 → opencode 卡片新增**模型展示管理**（openchamber 同款黑名单：`opencodeHiddenModels` 存 slug 数组、默认全显示，不写 opencode 配置文件）—— provider 可折叠分组 + 每行眼睛开关（隐藏行 45% 透明保留可随时恢复）+ 组头批量隐藏/显示 + 搜索过滤（搜索时自动展开全组），保存时顺手清理 catalog 已不存在的残留 slug；消费方统一过滤：模型选择器（当前已选模型即使被隐仍能解析显示名，弹层底部「已隐藏 N 个」入口跳设置）+ 赛马角色目录（默认模型兑底也只取可见集）· **一律不展示「免费」标签**（用户拍板）：自定义 provider（source=custom）的 cost 0/0 是 opencode 未定价兑底非真免费，归一化层抹成 undefined，详情卡价格行只陈述事实（In $x · Out $y / 未定价）· **设置页全量实时保存**：移除草稿快照与底部保存钮，单一数据源 = store settings，所有控件改动经 `commit(patch)` 按字段即时写盘（根治「旧草稿整体回写冲掉即时改动」类问题）。
>
> 🆕 **2026-07-29 追加（总控制台 Mission Control，详见 §4.18）**：侧栏新增总控台入口（LayoutDashboard 图标 + 待处理角标），无活动会话/赛马时作为首页 · **三列看板**（进行中 / 等你处理 / 最近完成）+ workspace 过滤 chips + 搜索 · **卡面直批**：permission 一键批准、ask_user 一键作答、steer 追加指令、错误一键重试、停止/全部停止、Goal 暂停续跑+预算条，全部不必切入会话 · **信息密度**：Plan 进度环、成果摘要卡（最终回复+文件变更统计+标记已读）、上下文水位条、费用角标 · **赛马泳道**（分段进度条 + 被打断徽章，judging 未采纳进待办列）+ **cron 任务条**（下次运行倒计时/立即运行/启停/跳上次会话） · **键盘流** j/k/Enter/a + / 聚焦搜索 · **任务栏角标**（setOverlayIcon 红圈白字，待处理数实时同步）· 纯增量渲染不碰消息持久化路径。
>
> 🆕 **2026-07-29 追加（标题栏品牌位调整 + 悬浮高亮品牌化，详见 §4.1 / §4.11）**（⚠ 其中「悬浮描边品牌化」已于同日被用户推翻 — hover 统一改背景色，见更上方追加与 §4.11）：标题栏最左改为**品牌区**（BrandMark+程序名，Windows 应用图标惯例位、品牌优先），侧栏折叠钮**紧随品牌其后**（取代原「固定标题栏最左」——品牌宽度恒定，按钮两态位置依然不变，图标交叉旋转动效保留）· **悬浮描边高亮全局统一品牌 accent 色**（原 `hover:border-ink-faint` 中性灰在深色主题下发白、与品牌色不符，共清理 9 处）：普通动作按钮用全强度 `hover:border-accent`；带 accent 选中态的卡片/筛选 chips 用弱档 `accent/40~60` 避免 hover 与选中态混淆；危险操作的语义色 hover（warn/err）与输入框聚焦态 `focus:border-accent` 保持不变。
>
> 🆕 **2026-07-29 追加（omp 第四引擎接入 + 引擎选项置灰，详见 §4.17）**：**Oh My Pi（omp）引擎完整接入**（`omp acp` 每会话子进程，ACP 基建同 kimi；原生 fork/resume/plan 只读沙箱；approval 与精细思考档走 spawn flag，运行时 thinking 档随模型动态扩展；后台自发回合 background 收尾对齐 codex 约定）· 新 UI 形态：**TaskCard 子代理进度卡**（卡内进度流 + 「子代理免审批」常驻警示）、编辑卡 **proposed 两阶段预览态**、工具输出图片缩略图+灯箱、toolKind 动词表扩展（lsp/debug/browser/eval/hub 等）、⌥ 引擎图标 · 赛马支持 omp（只读角色走真 plan 沙箱，不进 kimi 式 prompt guard 名单）· **引擎选项全局显示 + 按安装状态置灰**（chatStore.engineAvailability，六处入口；欢迎页默认选中不可用时自动切首个可用）· 引擎选择顺序统一 **codex → opencode → kimi → omp** · 用量统计纳入 omp（真实 token）· 设置页 OmpConfigCard（版本 pin 17.1.8 漂移警告 + 目录加载）。
>
> 🆕 **2026-07-29 追加（提问流内记录卡 QuestionRecord，仿 ChatGPT「Questions Answers」，详见 §4.3）**：ask_user 在对话流里的历史记录由单行小字升级为独立记录卡（To-dos 卡同风：圆角描边 + 头部栏）——头部 = 问号图标 +「模型提问」（与底部作答卡外标签同名同图标）+ 右侧状态角标（待答 BrandSpinner 琥珀 / 已答 ✓ 绿 / 跳过 × 灰）；卡身 = 加粗问题原文永久保留 + 下方一行回答（选项作答显 ✓+选项名；自定义回答以 `Other: 原话` 留档——新增 `answeredNote` 可选字段 + store `noteAskUserAnswer`，提问卡输入框提交时先把原文原地补进对应 ask_user 消息再走取消+排队重发，只增字段不增删消息、随会话持久化；跳过/取消显灰色小字「已跳过」；待答显 shimmer「等待作答…」）；作答入口仍在底部 PermissionSheet；授权（permission）记录保持单行小字不卡片化，避免高频授权刷屏。
>
> 🆕 **2026-07-29 追加（满窗降切规则，配置驱动，详见 §4.10）**：上下文占用达自动压缩阈值时，若当前模型命中规则表（settings `contextFallbackRules`，每条 `{match, to}`，默认内置 **k3 256k → k3**——同能力不同上下文窗口的模型对），则**不压缩而是在回合边界热切**到可用列表中命中目标的模型继续任务（长任务不被压缩中断），并在对话区插入系统提示行「🔀 上下文已用 N%，已自动切换模型：A → B」（类 Claude Code，随会话持久化）· 模型名**词元通配**：小写化剔除分隔符后包含判断，兼容 "Kimi k3 256k"/"kimi-k3-256K" 等任意写法；候选须命中 to 且不命中 match 防自切自，多候选优先归一化精确对应者（不会误切 K3 Turbo）· 规则全部未命中回退原有自动压缩；切完后乐观更新当前模型防重复触发 · 设置-通用页新增「满窗降切规则」分区可视化增删（匹配模型 → 降切为 两列输入 + 添加/删除）· 判定在 chatStore `turn.ended`，规则清洗回填在主进程 settings migrate（老用户自动回填内置规则；故意清空 = 彻底关闭）。
>
> 🆕 **2026-07-29 追加（侧栏交互优化，详见 §4.1）**：侧栏展开/折叠升级为**宽度+滑出动画**（外层容器 256px↔0 过渡、内容同步左移滑出、主内容区平滑跟随，cubic-bezier(0.32,0.72,0,1) 缓动）· 切换按钮**固定到标题栏最左**（展开/折叠两种状态位置不变，PanelLeftClose/Open 图标交叉旋转缩放淡入淡出；drag 区内 button 天然 no-drag 可点击）· 移除侧栏内折叠按钮与折叠态左缘把手，折叠后左缘 2px 隐形热区悬停仍可 peek 浮出侧栏（浮层动画升级为位移+透明度渐变）· Workspace/Project 会话行右侧按钮顺序调整为 ⋯菜单居左、**+（新建会话）固定最右缘**（最高频操作贴边，引擎弹层 right-0 右对齐不溢出窗口）。
>
> 🆕 **2026-07-29 追加（右侧 rail 交互修正，参考 codex）**：**rail 图标列常驻、不再可折叠**（删除 rail 折叠态 + 右缘悬浮把手/悬停 peek 浮出）· rail **顶部首个按钮**折叠/展开的是**整个右侧面板区**（开着显 PanelRightClose、收起显 PanelRightOpen，按钮激活态高亮、固定占位不随开/收位移）· 展开回最近激活 tab；chat 会话无 tab 时直接新开一个 sidechat 分支 · 折叠时若停在 plan tab 同步清 planPreview 标记防自动重弹 · 移除 store `railCollapsed`/`toggleRail`（localStorage 键 `cs.railCollapsed` 废止）。
>
> 🆕 **2026-07-29 追加（模型提问卡改版，仿 ChatGPT「Asking questions」，详见 §4.3）**：ask_user 底部弹层重做为深色圆角卡——卡外灰色小字标签「模型提问」；卡内 = 问题标题（加粗）+ `< 1 / N >` 分页器（多条待处理授权/提问间循环切换，授权卡标题行同获分页器，取代原「N 项等待」徽章）+ × 关闭（取消提问）；选项由按钮排改**纵向列表**（序号圆圈 + 名称加粗截断 + hover 浮出箭头，整行点击作答）；底部新增补充说明输入行（回形针图标；回车/「发送」提交 = 取消当前提问 + 文本经新 `enqueueTo(sessionId,…)` 排入该会话队列、回合结束自动派发；有文本时 Skip 自动切换为发送钮）+ 圆角 Skip 钮（reject 类选项不进列表、映射至此，如 kimi 桥接自带 `q0_skip`）。
>
> 🆕 **2026-07-29 追加（主题系统重构：明暗模式 × 配色主题）**：扁平三态主题拆为**二维主题**——`themeMode`（浅色 / 深色 / 跟随系统）× `themePalette`（Notion 米白 / Solarized 暖阳 / Everforest 森林，均为阅读向色板，每套含明暗两个变体）· 跟随系统 = 渲染进程 matchMedia 实时监听 + 主进程 nativeTheme 建窗解析 · 主题属性挂 `<html>`（data-palette/data-mode），body 级 portal 弹层（WorkspaceDialog 等）同样继承主题变量 · 原生标题栏按 6 组 palette-mode 配色联动 · 设置页拆「明暗模式」「配色主题」两个选项，侧栏齿轮子菜单分组单选 · 旧 `theme` 字段自动迁移（notion/light→浅色+notion，dark→深色+notion）。
>
> 🆕 **2026-07-29 追加（回合导航刻度条 TurnRail，codex 桌面版同款）**：对话区左缘纵向居中一簇横线刻度、每轮问答一根（超过 3 轮才显示）· 默认低调小灰线 + 当前轮随滚动联动微弱提亮 · 悬浮刻度变长变亮、邻近横线按与焦点距离高斯衰减跟随（鱼眼波形平滑动画）· 悬浮浮出该轮缩略卡（提问+回答标题/摘要）、点击平滑滚动定位 · 颜色用主题变量 var(--ink) 明暗色板自适应、不再硬编码纯白 · 轮数超 24 均匀抽稀 · 详见 §4.15。
>
> 🆕 **2026-07-28 追加 3（右侧面板 tab 化重构，参考 codex 设计）**：新增 `RightDock` 统一标签栏——**终端与 sidechat 升格为与 文件/变更/Agents 并列的同级 tab**（plan 预览同列）· **终端与 sidechat 均支持多实例**（终端：store 台账 `terminals` + 主进程 PTY 按 tab id 管理，隐藏 tab xterm 保活滚动缓冲不丢；sidechat：`sidechats` 改为分支 id 数组，rail 钮每次点击新建独立 fork，关 tab 即删除该分支会话）· **workspace 多根目录终端**：rail 终端钮默认开 primary 根，tab 栏“+”菜单列出全部根目录（首项标 Primary）可一键在任意文件夹开终端，tab 标签显示文件夹名、悬浮显全路径 · sidechat “只读分支”说明不再常驻面板头部，改为悬浮其 tab 时 tooltip 展示 · 删会话时同步清理其终端 PTY 与 sidechat 映射。
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
- 第四引擎：Oh My Pi（omp）CLI（oh-my-pi，pi 的 batteries-included fork；经 `omp acp` ACP stdio 驱动，每会话一个子进程；模型/凭据完全委托 ~/.omp，支持 kimi/minimax/deepseek 等自定义 provider 与订阅 OAuth）
- 模型：用户自有 kimi token plan（kimi-for-coding）+ minimax token plan（MiniMax-M3），provider 已通用化可任意添加
- codex 的模型出口：内置 ai-server 代理（用户自有 responses↔chat 转换服务裁剪版，utilityProcess 托管）
- 视觉主身份：codex 桌面版风格；二维主题 = 明暗模式（浅/深/跟随系统）× 配色主题（Notion 米白默认 / Solarized 暖阳 / Everforest 森林，阅读向色板各含明暗变体）
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
Renderer (React+Tailwind+zustand, i18n zh/en, 二维主题)
   ←IPC(typed, shared/ipc.ts)→ Main (Node)
        ├ SessionManager ── 会话生命周期/持久化/未读/通知/fork/steer/compact
        │    ├ KimiAdapter   → spawn `kimi acp`（ACP stdio）
        │    ├ CodexAdapter  → spawn `codex app-server`（ndjson JSON-RPC v2）
        │    ├ OpencodeAdapter → 共享单例 `opencode serve`（HTTP REST + SSE 事件流）
        │    └ OmpAdapter    → spawn `omp acp`（ACP stdio，同 kimi 基建；approval/思考档走 spawn flag）
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
- 每个 Workspace/Project 会话行 hover 右侧浮现 + 号：一键在该工作区/项目目录下开新会话；+ 固定行内最右缘（最高频操作），⋯ 管理菜单居其左
- + 号新建均先弹引擎选择（EnginePick）：codex/opencode/kimi/omp 品牌图标 + 名字列表（复用 EngineIcon，未安装项置灰），建会话时定引擎、避免进会话后换引擎走 forkToEngine 产生分支；菜单开启前测量按钮位置，距视口底部不足一个菜单高（<170px）时自动改向上弹出，chats 分组靠屏幕底时不被窗口下缘遮挡
- Workspace 实体：命名 + 多文件夹（首目录为 cwd，其余目录经 contextSeed 前缀注入告知引擎）
- Workspace 管理菜单（···）：管理工作区（名称/文件夹对话框）/ 打开终端 / 在编辑器打开 / 在文件管理器中打开 / 归档全部对话 / 从侧栏移除
- 「从侧栏移除」带守卫：本身只解散分组、不删会话（组内会话按首目录 cwd 回落 Projects 分组）；组内还有未归档对话时菜单项禁用，tooltip 提示「组内还有对话，清空后才能移除」——判断基于全量会话列表、不受侧栏筛选器影响，已归档对话不阻止移除（DotMenu 组件新增 disabled/title 通用禁用态）
- Project 组头菜单（···）：打开终端 / 在编辑器打开 / 在文件管理器中打开 / 归档全部对话
- 「在文件管理器中打开」：workspace 取首目录、project 取 cwd；主进程 `openIn('explorer')` 对目录直接 openPath 打开文件夹内容，对文件才 showItemInFolder 在父目录定位选中（文件预览的定位行为不变）
- 「归档全部对话」带二段确认（DotMenu 新增 confirmLabel 通用确认态：首次点击图标换勾、文案换「再点一次确认归档」、黄色警示底色，再点才执行；移开鼠标/关菜单/Esc 均重置）；归档范围取全量会话列表不受侧栏筛选器影响，project 组谓词与分组规则一致不误伤 workspace 内会话；workspace 组无未归档会话时该项置灰
- 会话行状态位（codex 风，统一在行尾）：运行中灰色转圈 / 等待回答蓝色问号（LLM 提问或待审批）/ 出错红色叹号 / 未读金色实心点（任务完成未查看）/ 空闲已读显相对时间；蓝色走主题化 `--info` token
- 侧栏会话行不提供删除 — 只能归档（二段确认：归档图标 → 黄色对勾 → 再点才归档，3 秒未确认/移开鼠标自动恢复）；彻底删除只在「已归档」页操作（删除仍是垃圾桶 → 红色对勾二段确认），防误删对话历史
- 筛选菜单（漏斗）：排序（更新时间/创建时间）+ 状态（全部/运行中/等待操作/出错/已完成）+ 仅未读 + 重置
- fork 分支树缩进展示（⑂ 前缀）；换引擎分支 ⇄ 前缀
- 未读机制：非活动会话回合完成标未读，选中即已读（main 持久化 + renderer 同步）
- 侧栏展开/折叠：标题栏最左为品牌区（BrandMark+程序名，品牌优先占 Windows 应用图标惯例位），切换钮紧随品牌其后（品牌宽度恒定，展开/折叠两态按钮位置不变，图标交叉旋转淡入淡出）；动画 = 外层宽度容器 256px↔0 过渡 + 内容同步左移滑出（overflow-hidden 裁剪，主内容区平滑伸缩）；折叠后侧栏仍挂载（w-0 隐藏），左缘 2px 隐形热区悬停 peek 浮出 overlay 侧栏（不挤压内容区，位移+透明度渐变），点标题栏钮常驻展开；侧栏内部不再单设折叠按钮
- 左下角：定时任务矩形入口 + 齿轮菜单（语言/明暗模式与配色主题快速切换 + 进入全页设置）

### 4.2 新会话页
- 引擎切换：Codex / opencode / Kimi Code / Oh My Pi（顺序统一；未安装项置灰不可选，默认选中不可用时自动切首个可用）
- 引擎品牌图标（EngineIcon，全局复用）：codex=OpenAI 结、kimi=K 字标，单色跟随 currentColor 适配明暗主题；opencode=官方块状光标（粗边框空心竖长方形，边框约占宽 1/4，铺满视窗高对齐 codex/kimi 视觉体量），固定金属银纵向渐变（上亮→中暗→下回光，#cfd2d6→#9aa0a8→#8f959d→#b7bbc1）不随主题变色，渐变 ID 用 useId 按实例隔离避免多处渲染冲突
- 三张卡：Chat（无目录）/ Project（选单目录）/ Workspace（弹多目录工作区创建，建完直接开会话）
- 已有 workspace 列表快捷开会话

### 4.3 对话流
- 流式 Markdown 正文（黄色打字 caret 已废除 — 进行态反馈由下述各块自带标签 + 底部活动指示器承担；进行态标签全部固定英文不进 i18n，用户拍板）
- **思考块 ThinkingBlock（无边框，2026-07-29 重构）**：流式中 🧠 图标 + "Thinking" 流光文字（.shimmer-text），正文默认展开、限高 8 行、新内容自动滚底、顶部渐隐遮罩；结束自动折叠为 "Thought for Ns"（点击展开全文，用户点击覆盖默认态、流结束复位）；**真实思考时长**：opencode reasoning part 自带 time.start/end，adapter 随 thinking.delta 下发 durationMs（SSE 快照常整段突发送达，渲染端墙钟会把几秒思考算成几十毫秒），time.end 晚到时空 delta 单独回填到本回合最近思考段；kimi/codex 无此数据走墙钟兑底
- **工具调用聚合组（MessageList 分组渲染层，qoder 风）**：连续同类工具自动聚合为可折叠组 — **Explore 组**（read/search/fetch）：进行中 "Exploring" 流光 + 左竖线明细流（动词过去式行：Grepped/Globbed/Read/Searched + 对象 + N results，命中数来自 grep/glob metadata），全部完成自动折叠成 "Explored N files · M searches"；**Shell 组**（execute）：进行中 "Running" + 命令卡流，完成折叠成 "Ran N commands"（失败时附红色 "M failed" 计数）；**思考段并入组内**渲染（Thought 行嵌组里不切断分组、紧邻的前一段思考回拉入组，正文叙述才切断）；进行中强制展开、结束复位默认折叠可点开；回合结束时遗留 in_progress/pending 工具收敛 canceled（防组永停进行态）
- **编辑卡片 EditCard（矩形框）**：文件类型品牌色图标（FileTypeIcon 扩展名映射：tsx/jsx=React 原子青、ts 蓝、js 黄、json/css/vue/py/rs/go 等各随品牌色，未知回退灰；已导出可全局复用）+ mono 文件名（悬停全路径）；进行中卡面 accent 扫光（.card-sweep）+ 右侧 "Generating…" 流光；完成右侧 **+N -N 行数变更 + A/M/D 字母徽章**（opencode edit 的 filediff.additions/deletions metadata；write 按 exists 判 A/M、新文件行数用入参内容兑底）；失败 "Failed" / 取消 "Canceled"；点开逐行着色 unified diff（PatchView：+绿 −红 @@ 灰）
- **shell 命令条 ShellCard（单行框）**：终端图标 + mono 命令文本 + 右侧状态（Running… 流光 / Ran / 非零退出码 Exit N 红 / Failed / Canceled）；点开实时输出（运行中 metadata.output 流式更新 + 自动追底）
- **内联 To-dos 卡片**（plan 消息，todo.updated 折叠）：头部 ☰ To-dos + 右侧 "N/M done" 进度；条目状态就地刷新 — 待办空心圈 / 进行中旋转 loader / 完成灰色圆圈勾（文字不划线不置灰，用户拍板）；todowrite/todoread 工具行过滤不渲染（卡片已呈现）；与 Composer 上方 PlanWidget 常驻进度条并存
- **底部活动指示器**：旋转 ✳ + "Working…" 流光，**仅静默空窗期显示**（流末尾存在任何可见进行态 — 流式思考/正文、进行中工具、未应答审批 — 即隐藏，避免与各块自带标签同词重复）；prompt 在途（sending）也算进行态，发送到回合开始的窗口期不像死机
- 审批记录行：待处理 "Waiting for approval" 流光，应答后绿/红结果徽章；数据链路：OpencodeAdapter tool 分支提取 state.metadata（filediff/diff/matches/count/exit/exists）+ toolName 原始工具名透传（明细行动词依据）+ grep/glob 归类 search；错误卡与思考正文长串 overflow-wrap:anywhere 防撑破边框
- **折叠块平滑收展 + 无跳变滚动跟随**（2026-07-29）：所有自动/手动折叠区（Running/Exploring 工具组明细、Thinking 正文、ShellCard 输出、EditCard diff、ToolLine 输出）统一走 `Collapsible` 容器 —— `grid-template-rows 1fr↔0fr` 200ms 高度过渡（无需测量内容高度），完成态自动收起不再整块一帧消失；关闭动画跑完后延时卸载 children，长会话不积压隐藏 DOM · 贴底跟随在原 messages effect 基础上增加 **ResizeObserver 观察内容容器**（ChatView 与 SideChatPanel 各一），动画期间高度逐帧变化持续重贴底部，收起表现为平滑下滑而非跳变、流式增高跟随也更顺；用户上翻阅读时收起发生在视口下方不影响阅读位置，手动折叠上方旧块由 Chromium 原生 scroll anchoring 兜底
- 审批底部卡（Approve once / Approve for session / Reject）+ **AskUserQuestion 提问卡**（2026-07-29 改版，仿 ChatGPT「Asking questions」：卡外灰色小字「模型提问」标签；深色圆角卡 = 问题标题 + `< 1 / N >` 分页器（多条待处理授权/提问循环切换，授权卡同获）+ × 关闭（取消）；选项纵向列表——序号圆圈 + 加粗名称截断 + hover 箭头，整行点击作答；底部回形针 + 补充说明输入行（提交 = 原文先以 `Other: …` 留档进消息记录（`noteAskUserAnswer`）+ 取消提问 + `enqueueTo` 排入本会话队列、回合后自动派发，有文本时 Skip 变发送钮）+ 圆角 Skip（reject 类选项映射，如 kimi `q0_skip`）；kimi 桥接现为单问题单请求、选项仅 label，无 description/Recommended 数据）
- **提问流内记录卡 QuestionRecord**（2026-07-29，仿 ChatGPT「Questions Answers」）：ask_user 在对话流的历史记录为独立卡片（To-dos 卡同风头部栏：问号图标 +「模型提问」+ 右侧状态角标：待答 BrandSpinner 琥珀 / 已答 ✓ 绿 / 跳过 × 灰）；卡身保留加粗问题原文 + 一行回答：选项作答 ✓+选项名 / 自定义回答 `Other: 原话`（新增 `answeredNote` 可选字段，只增不删随会话持久化，旧历史无此字段照常渲染）/ 跳过取消灰字「已跳过」/ 待答 shimmer「等待作答…」；授权（permission）记录仍为单行小字，高频授权不刷屏
- 任务清单 PlanWidget（sticky）
- **Plan 计划文档卡**（Plan 模式产出的 md 长文本）：卡片内直接渲染 md 预览（限高 + 底部渐隐），点卡在右侧面板开完整预览（预览中卡片收起成单行小条）；卡上支持 复制 / 下载 / 「按此计划实施」（赛马角色会话隐藏实施钮、预览改弹窗）；**下载文件名 = 计划标题 + 时间戳**（`标题_YYYYMMDD-HHmm.md`，重复下载不撞名），标题取正文 md 一级标题，无标题时取首个有意义文本行（剥列表/加粗/引用记号截 30 字）兜底，不再千篇一律叫「计划文档」（planDoc.ts `extractPlanTitle`/`downloadMarkdown`，卡片/右侧面板/赛马弹窗三处下载入口共用）
- 回合统计行：有真实 usage 显示 ↑上行（含缓存比）/ ↓下行 / t/s / 用时；无真实 usage（kimi ACP 不推 usage_update）时只显用时，不再展示 `~` 估算 token
- 消息持久化（debounce 写盘）+ 会话恢复：**选中会话即预热引擎**（sessionWarmUp IPC → ensureRuntime + ACP session/resume，取代“首条消息才惰性复活”），模型/思考深度/命令选择器立即就绪
- cron/steer 等 main 侧发起的消息经 `user.echo` 事件回显气泡
- **重启中断任务状态收敛**：运行态实时持久化（session.status 事件即写 meta）；重启后上次仍在执行/待回答的会话自动标**未读**（侧栏醒目提示半截任务）；被打断的进行中工具调用收敛为 **canceled**（灰色 ×，与真正的 failed 红色区分），未应答的权限/提问卡锁定；磁盘文件收敛后回写避免长期留存脏状态

### 4.4 Composer（输入区）
- 功能条布局（左→右）：引擎图标 → 模式（Agent/Plan）→ 权限 → ⚡Swarm → 🎯Goal ｜ 模型 → 思考深度（codex/opencode）→ 上下文圆环 → 展开 → 发送
- **5 级响应式退避**（控件条宽度收窄时按优先级依次退避，ResizeObserver 断点 730/650/560/470/400px）：①权限变图标 → ②隐思考深度 → ③隐模型名 → ④隐权限图标 → ⑤隐 Agent/Plan；引擎图标/放大输入框/发送按钮永不退避（Agent/Plan 隐藏后 Shift+Tab 仍可切模式）
- **输入框动态行高**：默认 2 行，Shift+Enter/粘贴多行时逐行增高，5 行封顶；永不显滚动条（`.no-scrollbar`）；无聚焦高亮边框（始终 border-line 暗边框）
- **ChipInput（contenteditable 输入框）**：拖入非图片文件 → 在光标处插入彩色文件引用胶囊 chip（`</> 文件名`样式）；Ctrl+C 复制/发送时 chip 序列化为纯文本 `文件名(绝对路径)`（拦截 copy/cut 按选区片段序列化）；纯文本粘贴去格式；保留 Enter 发送/Shift+Enter 换行/IME/空态占位符；chip 只由拖拽命令式插入不从字符串反解析（回填/清空为纯文本）
- **斜线命令菜单（slash commands）**：输入仅为 `/token`（/ 开头、无空格无换行 — 与各引擎「/name 须在消息起始处生效」语义一致；goal 模式不触发）时，输入卡片正上方弹出补全菜单（Codex 桌面版同款），随输入实时过滤（名称精确 > 前缀 > 子串 > 描述命中），分 命令组 / 技能组 两区，行 = 图标 + /名称 + 描述 + 全局/项目 徽章（tooltip 显示来源文件路径）；↑↓ 循环选择（滚动跟随）、Enter/Tab 插入 `/name ` 并把光标移到末尾（ChipInput.setPlainText 命令式整体替换）、Esc 关闭（记住关闭时文本，继续输入即恢复）、IME 组合中不抢键；候选来自主进程 slashService 只读目录扫描（每次唤起重扫，无缓存）—— skills（目录内含 SKILL.md，frontmatter 取 name/description，容忍 UTF-8 BOM）：全局 ~/.codex/skills、~/.kimi-code/skills、~/.config/opencode/skills、~/.agents/skills，项目级 .codex/skills、.kimi-code/skills、.opencode/skills、.agents/skills；commands（*.md，取 frontmatter description 或首个有效正文行）：全局 ~/.codex/prompts、~/.config/opencode/commands（兼容 command 拼写），项目级 .codex/prompts、.opencode/commands（兼容 command）；按会话引擎过滤可见性（本引擎 + generic，kimi 兼容可见 codex skills — kimi-code dist 实测其内置读取 ~/.codex/skills），同名条目项目级覆盖全局；kimi 自定义 command 走插件清单机制（无目录约定）故 kimi 会话仅列 skills；IPC `slash:list` 通道（cwd + engine → SlashItem[]）
- Agent/Plan 分段切换 + **全局 Shift+Tab** 循环切换（window 级监听，焦点在任意处均生效，阻止默认焦点导航）
- Plan 模式：权限选择器隐藏（不再显示底部“只读规划”提示文字，避免切换时输入框上下跳动）
- 权限（Agent 下）：手动审批 / 全自动 / YOLO
- 引擎徽章（功能条最左，纯品牌图标按钮，tooltip 显引擎名）点击 →「换引擎继续聊」：排除当前引擎的其余引擎列表（图标+名字），历史重放式分支到目标引擎（contextSeed 注入）
- ⚡Swarm 开关：发送时注入 AgentSwarm 并行委派提示词
- 🎯Goal（仅 codex，模式开关式）：点图标只切换「目标编辑模式」（不立即提交，输入框占位变「输入目标…」），按发送/回车才把输入作为 objective 提交 codex `thread/goal/set`（等价其 `/goal`）；提交即**乐观置入状态条**（引擎往返/懒启动期间不空窗，真实快照到达后覆盖，失败回滚并向消息流插错误行）；与 Plan **互斥**（进一方自动退另一方；codex 同款：plan 激活时隐藏 goal 状态条）
- Goal 状态条（输入框上方一行小字）：目标文本 + 执行计时 + 中止 / 继续 / 编辑（回填输入框并进目标模式）/ 清除目标（垃圾桶图标）；**计时连续显示**：引擎只在结算点（回合边界/goal 工具调用）推 timeUsedSeconds，两次推送间按本地墙钟秒级外推 + 单调保护（快照到达不回跳），暂停定格、换目标归零；**完成公告时序**：codex 模型先调 update_goal 标完成再流收尾总结，故 🎯 完成公告（目标+真实用时）暂存至该回合 turn.ended 后再插入消息流，排在最终输出之后（空闲时到达则立即插）
- **TopRails 叠层行条卡**（codex 风格）：等待发送 → 待办 → Goal 三行条组成输入框上方的独立窄卡（`mx-4` 较输入框内缩 32px, rounded-t-xl, `-mb-px` 底边与输入框顶边重叠衔接）；三者均无内容时整卡不渲染（plan 可见性与 PlanWidget 同规则：运行中或未全部完成）；待办行条收起态**只显「待办 + 进度 n/m」**、不展示当前任务文本（详情点开展开列表看）
- 上下文圆环：发送按钮旁 SVG 圆环显示占用比例（>65% 黄 >85% 红），点击弹详情卡，确认后触发 compact（kimi 发 `/compact`，codex 调 `thread/compact/start`）；任务进行中点压缩给「本轮结束后再试」提示（不排队）
- 压缩可见化（codex）：压缩过程渲染为工具行「正在压缩上下文…→已压缩上下文」，完成后由下一次 tokenUsage 回填「已压缩上下文：X → Y tokens」（真实释放量）；压缩失败以 error 显性化、不再静默
- **图片附件**：拖拽或 **Ctrl+V 粘贴截图**（剪贴板原始图像→写 `userData/pasted/` 临时文件拿路径）→ 输入框**内部顶部 14×14 圆角缩略图**（object URL 预览，免读盘）；点击弹全屏**灯箱放大预览**（遮罩点击/Esc/右上角 × 关闭）；悬停缩略图右上角 × 移除；CSP img-src 含 blob:
- 非图片文件 chip（中性色 border-line + bg-panel，不抢眼）
- **代码选区引用卡片**（§4.7 预览划选投递）：`{EXT} 文件名 #L起-止` 紧凑卡片（类型徽标 accent 色），× 移除、hover 显示完整路径、**点击弹快照预览浮层**（路径标题栏 + 带行号只读代码，Esc/点外侧关闭）；背后是**添加那一刻的代码快照 + 绝对路径 + 行号范围**（快照而非发送时重读——AI 改文件后行号不错位；同文件同范围去重；新卡片到达自动聚焦输入框）；发送时序列化为 `<selection path lines>` + fenced 代码块注入 prompt 最前（上下文在前、提问在后），引导语注明可用 read 工具按路径+行号扩展上下文；**截断保护**（Claude Code 同款 maxSelectionLength=2000）：快照本体不截断、注入时截到最后完整行并标注剩余读法，超限卡片带 warn 色「截」徽标；历史气泡回显只读卡片（随 user 消息持久化）；仅卡片无文字也可发送
- 展开按钮：长文输入大弹窗
- 思考深度选择器（codex/opencode 会话）：codex 档位取自当前模型 catalog 的 `supported_reasoning_levels`（缺省 low/medium/high/xhigh）；**opencode 档位 = 模型 reasoning variants 键名**（如 none/thinking、low/medium/high/max，无 variants 的模型自动隐藏控件；未显式选择时不下发 variant 跟随 server 默认）；滑条交互；拉满档（xhigh）时轨道金色流光 + 滑块脉冲光环 + 档位文字渐变流光动画（index.css `effort-max-*`）
- 模型选择器（右侧，与思考深度并排）：codex 候选来自 `model_catalog_json`（每项显示 displayName + 上下文窗口如 1M/256K + 图片模态图标），kimi 取 ACP 会话模型；**始终显示实际模型名**（无“默认”占位）；恢复态引擎未起时用持久化 modelId + catalog 兜底；切模型自动校正不支持的思考深度档；热切换（kimi unstable_setSessionModel；codex/opencode 下一 turn 生效）；opencode 用专属完整版选择器（见 §4.14）
- **引擎配置刷新（2026-07-28，改配置无需重启应用）**：渲染层唯一重读入口 `chatStore.refreshEngineConfigs()`（复用现有 engineConfigsGet IPC — 主进程本就每次现读磁盘；in-flight 去重，并发调用汇合到同一次 IPC）：模型选择器 / 思考深度选择器**展开弹层时后台自动重读**（不 await 不阻塞交互，store 更新后列表自动重渲染）—— 改 `~/.codex/config.toml` / model_catalog JSON 后点开选择器即见新模型与新默认档；各引擎生效路径：codex/kimi 新会话 spawn 时现读配置天然生效（已开 kimi 会话候选由 CLI 进程内固化，维持新会话生效语义），opencode 走其选择器 ↻ force 重启 serve 链路（§4.14）

### 4.5 发送队列与 steer
- 忙碌时发送 = 入队：发送按钮原位变为入队按钮（Clock 时钟图标，与发送按钮同位同款 accent 实心圆白图标，仅图标 ↑→Clock；无输入时禁用淡化不隐藏，位置不跳动） + 旁置停止按钮
- 新消息入队时队列头部条闪烁 accent 背景反馈（queue-bump 动画，面板常折叠时的可见确认）
- 队列面板（输入框上方，「等待发送 N」可折叠）：
  - 每行常显「✦ 等待中」呼吸动画标识（Sparkles + animate-pulse，文本右侧）
  - 新行入队时从上方滑入淡入（queue-row-in 180ms，仅挂载时播放；拖拽排序/重渲染不重播）
  - 拖拽把手排序
  - 编辑（回填输入框并移出队列）
  - 删除
  - steer：codex 走原生 turn/steer 注入运行中回合；kimi 降级为插队到队首
  - 携带的代码选区（§4.4）：条目显示 `+N 选区` 徽标（悬停列文件名）；编辑回填时恢复为输入框卡片；steer 注入/自动派发时随文本序列化携带
- 跨会话入队 `enqueueTo(sessionId,…)`（`enqueue` 委托之）：提问卡补充说明等场景直接向指定会话排队，不依赖 activeSessionId（sidechat 面板亦可正确入队）
- 回合结束后自动依次派发队首（出错时不派发）

### 4.6 执行心跳（网络中断可观察）
- 顶栏运行中显示：绿点脉冲「执行中」
- ≥12 秒无引擎事件：黄色「等待响应 Ns」
- ≥45 秒无事件：红色「疑似停滞 Ns」
- 数据源：任意引擎事件刷新 `ui.lastActivityAt`

### 4.7 右侧图标 rail + RightDock 统一 tab 面板
- **RightDock 统一标签栏（codex 同款 tab 化）**：rail 图标只做入口，面板本体是带统一 tab 栏的 dock——`文件 | 变更 N | Agents N | [终端×n] | [Sidechat×n] | [计划预览] | +` 并列同级 tab（变更/Agents 带计数徽标，数据提升到 dock 层与内容面板共用一份）；动态 tab（终端/sidechat/plan）悬停出 × 关闭，关后激活态落到邻居 tab、全关完自动收起；切会话时 activeTab 失效自动回退首个可用 tab；**“+”菜单** = 新终端（workspace 按根目录逐项列出，首项标 Primary）+ 新 Sidechat 分支；dock 开合走 DockReveal 宽度过渡（grid 列 0fr↔1fr 插值 220ms，中间消息区平滑让位而非瞬移，收起等过渡结束再卸载子树）
- 文件（工程树 + 预览/编辑，写入有 workspace 边界检查）；预览随 AI 编辑/回退**实时重读盘刷新**；编辑态有未保存草稿且 AI 改了同一文件 → 顶部冲突提示条（加载 AI 版本 / 保留我的），保存或切文件后清除；**文件树支持拖放导入**（从资源管理器拖文件/文件夹进树 → 拷贝导入到工作区根目录并刷新；拖入时描边高亮 +「松开导入到 XXX」提示；fsImport IPC 递归拷贝，逐个尽力单个失败不阻断）
- 审查变更（**接受/回退**，保命级）：列出本会话 AI 编辑过的文件（M/A/D 徽标 + 真实 +/- 行数，主进程 ChangeTracker 台账驱动）；每行悬停 ✓接受（保留改动、停止跟踪）/ ↺回退（还原到编辑前）；头部「全部接受」/「全部回退」（回退全部两次点击确认）；点文件行开左侧 **before/after diff 对照**（LCS 红绿着色、双列行号，借鉴 claude-code StructuredDiff）
  - 基线机制（**影子 git 快照**，对标 opencode Snapshot）：每 root 一个独立 GIT_DIR（`userData/shadow-git/<hash>`）叠在工作树上，不碰用户 .git、非 git 目录也可用（自带 info/exclude 排除 node_modules 等 + 尊重工作树 .gitignore）；会话首个回合开始（AI 未动手）`add -A + write-tree` 拍**基线 tree hash**（含用户未提交手改，race-free）；回退 = `git checkout <hash> -- <file>`（不在快照=删新建）；行数/类型 = `git diff --cached --numstat/--name-status`；shell/命令改动无 fileChange 事件 → 回合结束快照 diff 扫尾补登记；台账仅持久化 `{baselineHash, touched[]}`（`userData/changes/<id>.json`，轻量非全文），**app 重启后仍可回退**
  - 多会话共编同一文件：各会话持自己的不可变基线 hash，回退互不打架；文件名旁黄色「N 会话」徽标提示；共编文件的单文件回退需**两次点击确认**（会影响所有会话）
- **预览划选「添加到对话」**（VS Code Copilot 同款交互）：源码视图鼠标/Shift+方向键划选几行 → 选区末端浮出深色小按钮「添加到对话」（absolute 定位随内容滚动；mousedown preventDefault 保住选区；选区折叠/转移/文件刷新自动收起；拖出代码区钳回 <pre> 内）→ 投递为该会话输入框的选区卡片（§4.4）；行号由 DOM Range 的 textContent 偏移换算（跨 highlight.js token 准确；终点在某行第 0 列不计该行——Claude Code 同款规则；截掉末尾多选的换行使快照与行号自洽）；md 渲染预览/编辑态不支持（行号无意义）
- Agents（子代理活动卡片，按 title 前导动词匹配）
- **内嵌终端（多实例 tab）**：真 TTY 终端作为 dock 的同级 tab（不再开外部 PowerShell/cmd 窗口）；**支持同时开多个**：渲染进程 store 台账 `terminals`，主进程 PTY 按终端 tab id 管理；rail 终端钮默认在 **primary 根目录**（workspace 首目录 = 会话 cwd）新开/激活最近终端，tab 栏“+”菜单可选 **workspace 任一根目录**再开一个；tab 标签显示文件夹名、悬浮显全路径；非活动终端 tab 用 hidden 保活（xterm 实例不卸载，切回时滚动缓冲不丢），关 tab 才 dispose PTY，删会话同步清理其全部 PTY；后端 @lydell/node-pty 真 ConPTY（预编译 N-API 二进制，Electron 33 免 rebuild，无需本机编译器），前端 xterm.js + fit；支持颜色/光标定位/TUI(vim)/resize 同步；终端主题读 CSS 变量跟随应用配色；app 退出全部 kill + orphanSweep 覆盖；打包 asarUnpack 原生 .node
- 开分支 sidechat（所有会话可用）：rail 钮**每次点击都新建一个独立分支 tab**（不复用已有分支），悬停按钮即预热父引擎（fork 免等唤醒）；关 tab 即删除该分支会话（阅后即焚，详 §4.8）
- **rail 顶部首个按钮折叠/展开整个右侧面板区**（rail 图标列常驻不折叠；开着显 PanelRightClose、收起显 PanelRightOpen，按钮固定占位、激活态高亮）；展开回最近激活 tab，chat 会话无 tab 时直接新开 sidechat；折叠停在 plan tab 时清 planPreview 防自动重弹

### 4.8 sidechat / 分支
- kimi：ACP `unstable_forkSession` 实测 **-32601 未实现** → 降级「新 session + 历史重放」（contextSeed 一次性前缀，12K 字符截尾）
- codex：原生 `thread/fork`
- 客户端复制消息文件，分支立即可见完整历史；打开即预热分支引擎（sessionWarmUp）
- **多实例 + tab 化宿主**：分支挂在 RightDock 统一标签栏（store `sidechats` 为分支 id 数组，一个主会话可同时开多个分支 tab）；新建时**乐观先弹「分支创建中…」占位 tab**（fork/引擎唤醒后台跑，完成后原地替换为真实面板，占位宽度对齐真实面板不跳动；用户中途切走则不强制跳回）；**关 tab = 彻底清理该分支**（删除 fork 会话，引擎/消息/侧栏一并移除）
- **「只读分支」说明不再常驻面板头部**：鼠标悬浮其 tab 标签（及“+”菜单的新建项）时以 tooltip 展示；面板头部整体移除，标题/关闭由 tab 栏接管，省出的空间给消息流
- 右侧面板宽度可拖拽调节（左缘把手，300–720px，localStorage 记忆）；开合动画统一由 dock 的 DockReveal 宽度过渡承担
- mini composer 底缘与主输入框纵向对齐；含模型选择器（同主 Composer 兑底逻辑）+ 思考深度滑条（复用主 EffortPicker，align=left，codex/opencode 会话显示）；输入框行高与主输入框一致（2 行起 5 行封顶、无滚动条）

### 4.9 定时任务（Cron）
- 左下角入口 → 管理模态：列表（启停开关 / cron 表达式徽章 / 立即运行 / 编辑 / 删除）+ 新建表单
- 5 段 cron 表达式（支持 `* , - /`），零依赖自写匹配器（`cronMatch.ts`，17 用例单测过）
- 保存时校验，非法表达式给中文错误
- 触发：无头新会话（⏰ 前缀标题）执行 prompt，完成/失败系统通知，记录上次运行时间与结果

### 4.10 设置（全页，按类别分栏）
- **全量实时保存（2026-07-29）**：无草稿快照、无底部保存钮；单一数据源 = store settings，顶层 `commit(patch)` 传入各面板（PaneProps = { settings, commit }），每个控件改动直接按字段 patch 经 saveSettings 浅合并写盘；历史教训：旧版草稿机制（打开时 structuredClone + 保存钮整体回写）会把其他面板的即时改动冲掉（实测：隐藏模型后点保存被重置），故彻底移除草稿而非打补丁
- 通用：界面语言（简体中文/English 即时切换）/ 明暗模式与配色主题 / 发送键 / 自动压缩阈值（关闭 / 70/80/90/95%，默认 90%；占用达阈值时于回合边界自动压缩，绝不打断进行中回合）/ **满窗降切规则**（`{匹配模型 → 降切为}` 规则表可视化增删，默认内置 k3 256k → k3；达压缩阈值且当前模型命中规则时改为热切目标模型而非压缩，对话区插系统提示行；模型名词元通配忽略大小写与分隔符，详见顶部 2026-07-29 追加）
- 模型：CLI 配置只读快照 + 每引擎协议路由开关（详见顶部 2026-07-27 重大变更）；**opencode 卡片内含模型展示管理**（2026-07-29，详见 §4.14）；本页 ↻ 一次点击同时刷新本页快照与全局 codex 目录/默认思考档（与 Composer 选择器同源于 refreshEngineConfigs 同一次读取，天然一致，见 §4.4）
- 通知：任务完成 / 提问（审批与 AskUser）/ 报错 三开关（仅窗口未聚焦时发）
- 关于：版本信息
- 密钥 safeStorage（DPAPI）加密存储；renderer 只见掩码；掩码回写自动沿用旧密钥

### 4.11 主题与窗口
- 二维主题：**明暗模式**（浅色 / 深色 / 跟随系统）× **配色主题**（Notion 米白默认 / Solarized 暖阳 / Everforest 森林）；均为阅读向色板，每套含明、暗两个变体（各 16 个 CSS 变量）
- 跟随系统：渲染进程 `matchMedia('(prefers-color-scheme: dark)')` 实时监听切换；主进程建窗时用 `nativeTheme.shouldUseDarkColors` 一次性解析
- 主题属性挂 `<html>` 的 `data-palette`/`data-mode`（非根 div）：portal 到 body 的弹层（WorkspaceDialog 等）也继承主题变量；`:root` 回退 = notion 浅色防首屏闪烁
- 无边框 titleBarOverlay：标题条与窗口控制按钮颜色随主题即时联动（`windowTheme.ts` 按 6 组 palette-mode 配色 + themeSync IPC 推送已解析外观）
- 旧扁平 `theme` 字段自动迁移：notion/light → 浅色+notion，dark → 深色+notion；选择入口：设置页「明暗模式」「配色主题」两个选项 + 侧栏齿轮子菜单分组单选
- **按钮 hover 统一背景色（2026-07-29 用户拍板，推翻同日早前「悬浮描边品牌化」决策）**：所有可点击按钮 hover 一律背景色变化（hover:bg-bg-hover，可配 hover:text-ink），**禁用 hover:border-accent 悬浮亮品牌色边框**（用户：黄色边框难看；共清理侧栏新会话/总控台钮、新会话页三卡、赛马各钮、MissionControl chips 与卡片、选区胶囊、提问序号圈、ErrorBoundary 等 19 处）；两类 accent 边框场景不受此限：输入框聚焦态 `focus:border-accent`、常驻选中态（border-accent / ring-accent 表示当前选中项）；卡片型按钮可叠加 hover:shadow-md 增强可点感；危险操作保留语义色 hover（warn/err）
- 顶部 40px 全局拖拽条
- 单实例锁；退出防孤儿（所有引擎子进程 + 代理 + cron 随 app 关闭）

### 4.12 引擎层
- KimiAdapter（ACP）：initialize / session new-resume / prompt（附件 resource_link）/ 取消 / 模型热切 / 权限模式 / 审批与 AskUserQuestion 桥 / think 标签拆分 / usage / slash 命令透传 / compact(`/compact`)
- CodexAdapter（app-server v2）：thread start/resume/fork / turn start-interrupt-steer / item 事件映射（agentMessage、reasoning、commandExecution、fileChange、mcpToolCall、webSearch、collab）/ 审批 server-request 应答 / plan / tokenUsage / effort / compact / 权限模式映射（default=on-request+workspace-write，plan=read-only，auto=never，yolo=danger-full-access）；模式切换附带 `thread/settings/update` **热同步线程存量策略**（initialize 开 `experimentalApi`；goal continuation 等引擎自发回合不走 turn/start 传参、只认线程存量设置，不同步则切 YOLO 后续跑仍按旧策略弹授权；旧版 codex 无此方法静默降级）；**引擎自发回合（goal continuation / compact / review）完整生命周期**：turn/started 推 turn.started+running（主进程据此拍变更基线），结束发 `stopReason='background'` 的 turn.ended（无 usage 统计）+ 恢复 idle + 清 activeCodexTurnId；授权应答后无论哪类回合都把状态从 awaiting 拉回 running/idle；background 消费方约定：渲染端不产统计行/不派发队列/不触自动压缩（防压缩死循环），主进程不弹「任务完成」通知，赛马不误交卷
- OpencodeAdapter（HTTP + SSE，详见 §4.14）：共享单例 serve；session create/resume（服务端持久化直接续接）/ prompt（逐条带 model+agent+variant，**只以 SSE `session.idle` resolve 回合**，HTTP 响应仅作错误通道）/ abort / 原生 fork(`/session/{id}/fork`) / compact(summarize) / 权限模式映射（default→build agent，plan→plan agent，auto/yolo→build + adapter 自动应答权限 once/always 不弹窗）；SSE part 全量快照→自算增量 delta；steer/goal 不实现（UI 自动隐藏，opencode 无原生 steer，官方 CLI 也是串行队列）
- OmpAdapter（ACP，详见 §4.17）：initialize / session new-load(resume)-fork（均原生）/ prompt（附件 resource_link + effort→thinking 直发降级）/ 取消 / 模型热切（unstable_setSessionModel→set_config_option 双路径）/ set_mode plan↔default / 审批与 ask 桥 / background 自发回合收尾 / 命令黑名单 / 虚拟 URL 过滤 / compact(`/compact`)；approval/精细思考档走 spawn flag（见 §4.17 映射表）
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
- **完整版模型选择器**（OpencodeModelPicker，opencode 会话专属）：搜索框 + 收藏星标（localStorage）+ 最近使用（localStorage，最多 5）+ 按 provider 分组 + 上下文窗口/图片模态图标；**列表过滤隐藏黑名单模型**（bySlug 用全量目录 — 当前已选模型即使被隐仍能解析显示名；底部「已隐藏 N 个」入口跳设置）；**不展示「免费」标签**（自定义 provider 的 cost 0/0 是未定价兑底非真免费，归一化层对 source=custom 且 0/0 抹成 undefined）；**详情卡从弹层右侧浮出**（hover/当前模型：能力 Tool calling/Reasoning/附件、输入→输出模态、$/1M 价格行只陈述事实（In $x · Out $y / 未定价）、上下文、思考档位）；底部静态引导「连接更多 provider：终端运行 opencode auth login」；**刷新按钮 ↻ = 重启 serve 再拉目录**（opencode 无配置文件 watcher，运行中实例握旧快照，改 opencode.json 后仅重拉无效）
- **模型 id 规范**：复合 slug `providerID/modelID`；跨引擎 fork 继承的无 `/` 旧别名判无效强制重置（首选 zen 免费模型），防止 prompt 不带 model 时 server 静默用自己默认模型
- **catalog IPC**：新增 `opencodeCatalogGet` 通道，主进程代理 /config/providers（renderer 不直连 serve 端口，server 密码不出主进程）；按 server 代次缓存
- **设置页 opencode 区块**：CLI 安装状态/版本、opencode.json 存在性 + 引导文案；无路由开关（opencode 不经 ai-server 协议代理）；**模型展示管理（2026-07-29）**：手动加载 catalog（不被动启动 server）后展示 openchamber 同款黑名单管理区 — settings `opencodeHiddenModels` 存 slug（providerID/modelID）数组、默认空=全显示、只影响本程序内展示不写 opencode 配置；provider 可折叠分组（组头显「可见/总数」计数，全隐时警示色）+ 每行眼睛开关（整行可点，隐藏行 45% 透明保留可恢复，眼睛常驻可见 hover 提亮）+ 组头 hover 浮现「全部隐藏/全部显示」+ 搜索过滤（搜索时自动展开全组）；改动即时写盘，保存时顺手清理 catalog 已不存在的残留 slug；赛马 useRoleCatalogs 的 opencode 选项与默认模型兑底同样只取可见集
- **sidechat**：opencode 复用 kimi 同款 SIDECHAT_GUARD 只读指令前缀软约束（plan agent 会写计划文件，无 read-only 硬隔离）
- **探针**：`scripts/probe-opencode.mjs` 全链路契约实测（端点/SSE 事件枚举/permission 应答/fork/resume，1.17.18 验证通过）；依赖 `@opencode-ai/sdk@^1.18.5`（与 openchamber 同版，仅作类型参考，实现走裸 fetch 按探针实测的 legacy 端点）

### 4.15 回合导航刻度条（TurnRail，codex 桌面版同款）
- 对话区左缘纵向居中一簇横线刻度，每轮问答对应一根；**超过 3 轮问答（≥4）才出现**，3 轮及以下完全不渲染
- 无悬浮默认态：全部 12px、28% 透明度的低调小灰线；仅当前轮（随滚动联动：视口 35% 高度线之下的最后一轮）以 14px、50% 透明度微弱提亮，无突兀白色长条
- 悬浮交互（鱼眼波形）：悬浮刻度变长变亮（28px / 90% 透明度），邻近横线按与焦点的距离以高斯衰减 `e^(-d²/3)` 不同比例跟随变化（近高远低）；宽高与透明度均走 260ms `cubic-bezier(0.22,1,0.36,1)` 过渡，鼠标在刻度间滑动时波形焦点平滑游动
- 悬浮浮出该轮缩略卡（提问 + 回答首个 markdown 标题 + 纯文本摘要，摘要经 strip 代码块/图片/链接/列表/引用等标记，220ms 延时收起便于移到卡片上）；点击刻度或卡片平滑滚动定位到该轮问答
- 颜色用主题变量 `var(--ink)` + 透明度插值，暗色主题呈浅灰白线、亮色主题呈深灰线，全色板自适应，告别硬编码纯白扎眼
- 轮数超过 24 时均匀抽稀为 24 根刻度（首末轮必保留），滚动联动与点击跳转映射到最近刻度
- 刻度数据：每轮 = 一条 user 消息 + 同 turnId 首条 text 回答；乐观写入的 user 消息（turnId=-1）与引擎 user.echo 按文本去重；锚点 = 消息包装 div 的 `data-msg-id`；ResizeObserver 跟踪流式输出/折叠展开导致的高度变化重测偏移
- 实现：`src/renderer/src/components/TurnRail.tsx`（挂载于 ChatView 消息滚动区左缘）；i18n 词条 `turnRailJump` / `turnRailPending`（zh+en）

### 4.16 用量统计与供应商套餐余量
- **入口**：侧栏左下角、设置齿轮**左侧**，`CircleGauge` 圆形仪表盘图标（用户否决折线图 — 仪表盘才有「用量/额度」语义）；**悬浮**（180ms 延时）弹精简小窗，**点击**才打开全屏大窗
- **悬浮小窗**（256px，fixed 锚在侧栏左下角上方 — absolute 右对齐按钮会向左伸出窗口左缘被裁，实测踩坑）：今日用量（请求次数 / 消耗 Tokens 总・↑上行・↓下行）+ 分隔线下已配 key 供应商余量行；打开时拉当天聚合 + 余量
- **大窗 UsageView**（全屏覆盖层，SettingsView 同款返回交互）：
  - 顶栏：引擎筛选分段按钮（全部 + codex/opencode/omp）+ 时间范围选择器
  - 时间范围：当天/1d/7d/14d/30d 预设 + 自定义面板（起止日期时间字段、42 格日历跨月导航、起止端点高亮与范围染色、「结束时间跟随当前时刻」每秒 tick、起止倒置自动交换/校验）
  - 汇总卡：总消耗 Tokens（大数 + ≈万级换算）/ 总请求数 / 新增输入（上行减缓存）/ 输出 / 缓存命中 / 缓存命中率进度条；**不展示任何金额字段**
  - 使用趋势：**自绘 SVG 面积折线图（零图表库依赖）** — 左轴 tokens 三序列（输入/输出/缓存命中，渐变填充 + 中点贝塞尔平滑），右轴请求次数橙色虚线；悬停参考线 + 逐桶明细浮层；空数据居中提示；ResizeObserver 自适应宽度；打开期间 30s 自动刷新
- **数据链路（零新增存储）**：主进程 `SessionManager.usageStats`（IPC `usage:stats`）扫描 `userData/messages/*.json` 里的 turn_end 统计行（inputTokens/outputTokens/cachedInputTokens），按 sessions.json 的 engine 归属过滤；跨度 ≤24h 按小时桶、>24h 按本地日历天分桶（本地午夜反查索引，避开 DST），空桶补零；按文件 mtime 缓存抽取行防每次重析
- **kimi 排除规则**：kimi 无可靠真实 token 上报（仅字符数估算）→ 对话统计行不显示任何 token 数（只留用时），聚合一律跳过 kimi 会话，筛选器不列 kimi
- **供应商套餐余量**（`providerQuota.ts`，IPC `usage:provider-quota`，接口口径对齐 cc-switch，全部 Bearer apiKey）：
  - Kimi For Coding：`GET api.kimi.com/coding/v1/usages` — limits[].detail=5小时窗、顶层 usage=周窗，limit/remaining 换算已用%
  - MiniMax：`GET api.minimaxi.com`（国际站 `api.minimax.io`）`/v1/api/openplatform/coding_plan/remains` — model_remains 取 model_name=general，剩余%反转为已用；周窗仅 current_weekly_status=1 时展示
  - DeepSeek：无 token plan，`GET api.deepseek.com/user/balance` 展示余额（balance_infos 的 currency/total_balance）
  - **key 探测**：kimi config.toml `providers.*.api_key` / codex config.toml `env_key` 环境变量 / opencode opencode.json options（支持 `{env:NAME}` 模板）+ auth.json，按 baseUrl 域名归类；**key 只在主进程使用，IPC 结果不含密钥**；5 分钟 TTL 缓存 + in-flight 去重；只返回探测到 key 的供应商（没配 = 不展示整个区块）
  - 展示：`5小时 X% ⏱4h7m · 7天 Y% ⏱1d2h`（已用% 按 <70 绿 / ≥70 橙 / ≥90 红），DeepSeek `余额 ¥…`；重置倒计时 >24h 显示 Nd Nh 否则 Nh Nm
  - **纵向对齐**：大窗 roomy 宽松模式（每时间窗定宽 w-52、标签/百分比各 w-12 定宽成列，多供应商行同类元素对齐）；小窗紧凑模式每时间窗独占一行同样定宽对齐（w-11）
  - 大窗独立「套餐余量」卡片带强制刷新按钮（跳过缓存）：刷新期间 BrandSpinner 持续转、完成即停（最短 600ms 保证命中缓存瞬回也可见），期间禁点防重复请求
- 实现：`src/main/usage/providerQuota.ts`、`SessionManager.usageStats`、`src/renderer/src/components/UsageView.tsx`（大窗+趋势图+日历选择器）/ `UsageQuota.tsx`（入口按钮+小窗+QuotaRow+useProviderQuotas）；i18n `usage*` / `quota*` 词条（zh+en）

### 4.17 omp 引擎（第四引擎，Oh My Pi，ACP）
- **接入形态**：每会话 spawn 一个 `omp acp` 子进程（ACP ndjson stdio，复用 kimi 的 `@agentclientprotocol/sdk` 基建）；Windows 原生单 exe（`%LOCALAPPDATA%\omp\omp.exe`，不依赖 bun/node），解析顺序：设置显式路径 → 安装器默认位置 → PATH
- **能力面**（probe-omp-findings 实测）：原生 `session/fork`（sidechat 真分叉，不降级历史重放）/ `session/load` resume / plan 只读模式（set_mode plan↔default 运行时可切）；approval 精细控制不在 ACP 运行时面 → **spawn flag 承载**（default→`--approval-mode always-ask`，auto→`--approval-mode write`，yolo→`--auto-approve`；中途切 auto/yolo 需重开会话）
- **思考档动态**：无模型时 configOptions 仅 off/auto；带 `--model` spawn 后值域扩展出目录 thinking[] 精细档（如 deepseek → off/auto/high/max）；适配器 effort 策略 = 原值直发 set_config_option，被拒降级 auto；Composer/赛马的档位选项 = off/auto + 目录精细档，非 reasoning 模型隐控件
- **usage 优先级**：prompt 响应真实 usage（inputTokens/outputTokens/totalTokens/cachedReadTokens）> usage_update 快照 > 字符估算；用量统计纳入 omp（不适用 kimi 排除规则，筛选器列 codex/opencode/omp）
- **后台自发回合**（异步 task/jobs 结果注入、auto-compact）：无活跃 prompt 时的内容事件合成独立回合，1.5s 静默后 `turn.ended(stopReason='background')` 收尾——对齐 codex 约定，赛马阶段机/通知抑制自动生效
- **安全防护**：虚拟 URL（agent:// pr:// conflict:// local:// xd://）双重过滤（适配器 mapLocations + SessionManager noteEdit）不进 ChangeTracker 台账；斜杠命令黑名单（share/export/stats/computer/browser/join/collab/say 等 GUI 不适用项不进菜单）；魔法关键词（ultrathink/orchestrate/workflowz）输入框检测到独立词时显琢珀色提示条（不拦截）
- **新 UI 形态**（omp 首发、引擎无关可复用）：
  - TaskCard 子代理进度卡（toolName='task' 或带 progress 分派）：运行中卡内最新进度行就地刷新 + 展开看尾部输出，完成后显 yield 摘要；卡头常驻「子代理免审批」警示（omp 对 headless 子代理强制 yolo，plan 模式除外）
  - 编辑卡 `proposed` 两阶段预览态（ast_edit 预览→resolve 落盘）：琢珀色「预览待确认」标签，落盘前可先看 diff；重启 reconcile 收敛 proposed→canceled
  - 工具输出图片（generate_image/inspect_image）：卡内缩略图 + 全屏灯箱
  - toolKind 动词表扩展：lsp→Inspected、debug→Debugged、browser→Browsed、eval/python→Evaluated、hub→Coordinated、web_search→Searched web 等
  - ⌥ 引擎图标（Option 符号自绘 path，currentColor 随主题）
- **模型目录**：`omp models --json` 主进程代理（IPC `ompCatalogGet`，进程级缓存 force 重拉）；实报字段 selector（即 slug）/thinking[]/reasoning/cost；自定义 provider（~/.omp/agent/models.yml）与内置目录自动合并；无凭据时空目录→引擎默认兑底
- **赛马集成**：RACE_ENGINES 含 omp；只读角色走真 plan 沙箱（readOnlyMode 非 kimi 分支），**不进 needsGuard prompt guard 名单**；思考档下拉 = off/auto + 目录精细档
- **设置页 OmpConfigCard**：安装状态/版本（pin 基线 17.1.8，不一致时琢珀色契约漂移警告）、CLI 路径、~/.omp/agent 存在性、模型目录加载/重拉；常驻行为提示（子代理免审批/魔法关键词）；只读不写 ~/.omp
- **引擎选项全局显示 + 按安装状态置灰**：chatStore.engineAvailability（refreshEngineConfigs 派生：opencode/omp 真实 CLI 探测，kimi/codex 配置存在性近似；null=未探测不置灰）；六处入口：欢迎页 tab（默认选中不可用时自动切首个可用）/ 侧栏 EnginePick / Composer 换引擎菜单 / 赛马三处下拉（option disabled + 「（未安装）」后缀）；置灰样式 opacity-40 + cursor-not-allowed + tooltip
- **引擎选择顺序统一**：codex → opencode → kimi → omp（欢迎页/侧栏/换引擎菜单/RACE_ENGINES 四处）
- **探针**：`scripts/probe-omp.mjs`（ACP 全面契约）；地面真值 `docs/probe-omp-findings.md`（含二次实测补正 §9）

### 4.18 总控制台（Mission Control）
- **入口与路由**：侧栏顶部新建会话钮右侧 LayoutDashboard 图标钮（带待处理数红色角标）；`chatStore.dashboardOpen` 驱动，无活动会话/赛马时占据主内容区（路由优先级 RaceView > ChatView > MissionControl > NewSessionView）
- **三列看板**：进行中（running/starting/sending）/ 等你处理（awaiting/error）/ 最近完成（按最后活动时间倒序 cap 30，前 12 张懒水合消息详情）；列头带计数徽章；各列独立空态文案；全空时 EmptyHero 落地页（新建会话 / 发起赛马两个 CTA）
- **过滤与搜索**：workspace/Projects/Chats 过滤 chips（带计数）+ 标题关键字搜索框（`/` 快捷键聚焦）
- **卡面直批**（SessionCard，全部操作不必切入会话）：
  - permission 待审批：卡面直接列选项钮（复用 permission.request 的 requestId+options），一键批准/拒绝；`a` 快捷键 = 选中卡按默认 allow 项批准（defaultAllowOption）
  - ask_user 提问：选项按钮直接上卡面作答
  - steer 追加指令：卡内展开输入行，运行中会话注入当前回合（codex 原生 steer）或排队到回合后；队列非空时卡面显示队列徽章
  - 错误会话：一键重试（重发最后一条 user 消息，BrandSpinner 进行态）
  - 运行中：单卡停止钮 + 「进行中」列头全部停止钮
  - Goal 会话：卡面显目标文本 + 预算进度条 + 暂停/续跑钮
- **信息密度**：Plan 进度环（SVG 圆环 N/M）· 完成卡成果摘要（最终回复首段 + 文件变更数统计 + 未读金点、悬停浮现「标记已读」）· 上下文水位条（>65% 黄 >85% 红，同 Composer 圆环阈值）· 费用/token 角标（有真实 usage 的引擎）· 引擎图标 + 相对时间
- **赛马泳道条**（有进行中赛马才浮现）：每场一卡，RACE_STAGE_ORDER 七段分段进度条（repairing 视觉归 auditing 段）+ 被打断徽章；**judging 且未采纳 = 「等你决策」**进待办列高亮卡（一键进入赛场）
- **cron 任务条**：启用任务行内展示下次运行倒计时（零依赖 `cronNext.ts` 前推匹配器）+ 立即运行 / 暂停恢复 / 跳转上次会话，不必进定时任务管理模态
- **键盘流**：j/k 在全部卡片间移动选中（accent 描边 + 自动滚入视口）、Enter 打开会话/赛场、a 批准选中卡首个待审批、`/` 聚焦搜索；输入汇聚焦时不抢键
- **任务栏角标**（App 级 useTaskbarBadge，不依赖总控台打开）：待处理数 = 非归档非赛马的 awaiting/error 会话 + judging 未采纳赛马；renderer canvas 画 32×32 红圈（#e5484d）白字（>99 显 99）经 `badgeSet` IPC → `win.setOverlayIcon`，归零即清；侧栏入口角标同源同步
- **数据安全**：纯增量渲染（只读 sessions/races/goals/queue/lastActivity + 懒水合消息），不触碰消息持久化路径；全部 zustand 选择器遵守稳定引用约开（EMPTY_XXX 常量兑底，见 §五坑表）
- 实现：`src/renderer/src/components/mission/`（MissionControl.tsx 看板主体 / SessionCard.tsx 卡面直批 / cronNext.ts cron 前推）+ chatStore `dashboardOpen/openDashboard` + App.tsx `useTaskbarBadge`；i18n `mc*` 词条（zh+en）

### 4.19 提问级回退（Undo to prompt，Claude Code「Undo changes up to this point」同款）
- **入口**：用户提问气泡 hover 时左侧浮现「↺ 回退到此处」小按钮（气泡左侧悬浮、不占纵向空间）；以下情形不显示：会话忙碌（running/awaiting/sending）、steer 插入消息、Sent as goal 提交、赛马角色会话（赛马流程状态机不允许历史被截断）
- **确认弹窗 UndoConfirmDialog**（点击按钮 → 先 `sessionUndoPreview` 拉预览再弹窗）：
  - 有文件变更：说明文案 + 文件行列表（A/M/D 色标 + 文件名 + 绿 `+N` 红 `-M`；被多会话跟踪的文件带黄色「N 会话」徽标警示回退会影响彼此）
  - 无文件变更：提示「确认后移除该提问及后续回复，并把提问放回输入框」
  - 无快照（旧会话历史 / cron 注入的提问）：降级提示「仅移除消息 + 回填」
  - 加载/执行中 BrandSpinner；确认失败错误就地显示；Esc/遮罩/× 关闭
- **快照机制（逐提问还原点，ChangeTracker `marks`）**：每次 prompt 发送前（AI 未动手，race-free）用 ShadowGit `add -A + write-tree` 拍一张 tree hash，按**用户消息 id** 记入台账（`userData/changes/<id>.json` 的 `marks[]`，100 条滚动淘汰，轻量非全文、**跨重启可用**）；快照与引擎启动并行，不拖慢首条消息投递；与 §4.7 的会话级基线（审查变更）相互独立；pure-chat（无 cwd）不拍快照恒走降级路径。IPC：`SessionPromptRequest.userMessageId` + `sessionUndoPreview` / `sessionUndo` 两通道
- **确认后执行链（SessionManager.undoToMessage，运行中拒绝）**：
  1. 文件还原：对「快照 vs 当前磁盘」的全部差异文件 `git checkout <hash>`（不在快照 = 删除）——含 shell 改动与提问之后的用户手改（弹窗如实列出即知情确认，Claude Code 同语义）；该时点及之后的 marks 一并作废
  2. 消息截断：先把完整消息列表**全量备份**到 `userData/messages/<id>.undo-bak.json`（数据安全底线，保留最近一次），再截断到该提问之前落盘；renderer 侧同步截断 + `persistNow` 立即落盘（掐掉 400ms 防抖窗口内旧列表回写风险）
  3. 引擎上下文重置：引擎侧历史无法截断（codex/kimi/omp 无 rollback API，opencode 原生 revert 需 app↔引擎消息 id 映射、现不存在）→ 统一关闭引擎进程、清 `engineSessionId`、截断后历史经 `serializeHistory` 写 `contextSeed`，下次发送自动新建引擎会话续接，**三引擎行为一致**
  4. 被移除的提问文本经 store `composerDrafts`（nonce 驱动、消费即清）回填输入框并聚焦，用户自行修改后重新发送
- 实现：主进程 `changeTracker.ts`（markPrompt/undoPreview/undoRevert）+ `SessionManager.ts`（undoToMessage）；渲染层 `UndoConfirmDialog.tsx` + MessageItem `UserBubble` + chatStore `undoToMessage/composerDrafts` + Composer 回填 effect；i18n `undo*` 词条（zh+en）

### 4.20 大模型赛马（竞争式规划工作流，DAG 编排）
- **定位与铁律**：重要任务的多模型竞争式规划（烧 token 换方案质量）；每个角色 = 真实独立引擎会话（RaceGroup 编排层，非特殊会话）；**只有执行者写盘**（codex/opencode/omp 只读角色走 plan 沙箱；kimi 无只读模式 → 强制 auto 自动批准（防泳道无审批区的死锁）+ READONLY_GUARD 提示词护栏兑底）；收敛后角色会话“毕业”为普通会话可继续使用
- **完整流程**：双/三选手盲跑并行规划（互不可见）→ 交叉反驳（单轮对称，方案冻结不改稿）→ 裁判（两道人工关口）→ 执行者实施 → 独立审计 → 修复回环（≤maxRepairRounds=3，超限终止未交付）
- **反驳三段式**（对象归属切割防写串）：⚔ 反驳（只谈对手方案缺陷，按选手分节）/ 🤝 吸纳（承认对手更优的点 + 若按己方实施如何吸纳；只列真正重要防过度设计，没有写“无”不硬凑 —— 声明而非改稿，冻结不破）/ 🛡 辩护（预判质疑的预防性澄清，只谈己方设计点）；互相吸纳的共识点 = 裁判高置信输入
- **裁判两道人工关口**：④a 采纳决策前置 —— 用户先选策略（采纳X / 以X为准结合其余；策略集按在场选手动态生成 4/6 项）+ 可选评语；④b 裁判严格按决策三段式出方案：一、最终方案（正文干净无溯源标注）/ 二、**设计溯源表**（主要设计点粒度，来源限定 选手X／共识／裁判补充；身份约束「你不是又一位选手」，裁判私货强制自曝供审计）/ 三、取舍说明；④c 批注 → 修订 v+1 循环（溯源表同步维护，批注改动标「用户批注」来源）→ 定稿交执行；出方案前可 **↩ 重新选择策略**（叫停裁判回合回选策略关口，出方案后改意见走批注道），选策略前可 **↩ 重跑规划**（清产物回炉）
- **第三选手 C（可选）**：A/B 必选、C 发起面板行内开关；三泳道并排、三方互驳（每人收到全部对手方案按选手分节反驳）、产物预览三栏、策略集扩为 6 选 1
- **✂ 剔除选手**（仅三人以上在场且裁判选策略前；剩余 ≥2 铁规）：泳道头/产物预览栏 ✂ 二段确认（变红再点，3s 自动复位）；**标记式不删数据**（eliminated 数组，会话/产物保留可查，产物不进裁判输入，裁判 prompt 注明忽略其余选手对被剔者的反驳）；被剔运行中回合就地叫停 + 僵死等待主动唤醒；剔除后剩余产物齐自动推进下一阶段；被剔泳道不占位（不展示残留卡）；不可逆
- **容错与重试体系**：瞬时错误自动重试一次（1.5s，用户主动中止/剔除不重试）；**逐选手产物落盘**（冲线即冻结，重试只补跑缺失方不重烧已完成侧）；泳道头三态 = 进行中[■中止] / 已冲线🏴 / 已停止[↻重试]（真实会话状态 + 产物落盘事实驱动，单选手重试不等其它选手）；错误横幅三出口 = ↩重选策略（judging）/ ⚙调整选手 / ↻重试当前阶段；**⚙ 调参即自动重跑**（保存后若阶段停摆自动重跑该选手，换引擎/模型重建会话，调了谁谁的当前阶段产物作废）；裁判/执行者等待面板均有 ■ 中止；同回合重试回显只发一行重试标记不重复贴指令原文
- **交卷判定 = 静默收敛**：回合正常/background 收束后等 2s 静默期，期间引擎续跑（codex 对大 prompt 拆多内部回合/自发回合）就继续等，真安静才交卷（此时 transcript = 最终产物）；异常收束立即上报；产物文本 = 会话「最后一段连续正文」（工具活动重置 + 懒重置：新回合真产出内容才清上回合正文，探索独白与空转自发回合都不污染产物）；空产出报错阻断不带病推进
- **寄生于宿主对话**：parentSessionId 绑定发起会话；⚔ 入口严格按当前会话过滤（本对话有未完成赛马 → 高亮（进行中 accent / 待继续警示色）+ 点击直入；只有已完成 → 下拉回看+发起；都没有 → 开发起面板；其它对话的赛马不可见）；发起可勾选**携带本对话上下文摘录**（用户/助手正文尾部 8K 字，注入双方规划回合作背景资料 —— 中途转赛马）；角色会话带 raceId 标记**侧栏隐藏**（只能从赛马视图/执行会话按钮进入）；发起/✂剔除/收尾（交付或未交付）均向宿主对话回流系统公告（永久留痕，可基于结果继续聊）；无宿主/宿主已删的赛马重启时收敛为已结束
- **设置 → 赛马**（⚔ 图标分类页）：默认启用第三选手开关 + 六角色（选手 A/B/C、裁判、执行者、审计）各一行默认引擎/模型/思考深度（模型可选「跟随引擎默认」、档位可选「默认最大档」）；发起面板打开时按此预填，每场仍可临时调；持久化 settings.race（老配置自动迁移）
- **重启恢复**：未完成赛马保留原阶段 + interrupted 标记（judging 纯等待态原样恢复）；进赛马视图「▶ 继续赛马」手动重跑当前阶段（不自动防重启风暴；已落盘产物跳过不重烧）；泳道自行触发会话消息水合（已冲线角色恢复后历史完整可见）
- **竞态防护（编排器内建）**：阶段链存活标记（链活着时重试/剔除不代推进、resume 拒绝重入防双发 prompt）、代际计数（重跑规划后旧链尸变静默退出）、重试接管让位（链收尾时缺产物方正被重试 → 不抛旧错交棒推进）、定稿同步切阶段防双击 Builder 双发、superseded 中性打断语义（撤回/重跑/剔除的叫停不弹假错误横幅）
- **赛马视图 UI**：赛程电路 HUD（双规划→交叉反驳→裁判→执行→审计五节点）；泳道渲染**完全复用主区 MessageList**（thinking 动效/shell 动效/自动折叠同源同步），但隐藏主对话专属交互：token 统计行（竞速只看产出，消耗看用量页）、「回退到此处」（编排提问不可回退）、「按此计划实施」（实施走定稿→执行链路）；Plan 卡点击/⚢ 改**弹窗预览**（无右侧面板可用）；裁判阶段 = 冻结产物干净预览（每选手方案文档 md + 反驳/吸纳/辩护折叠，不展全过程原文噪音）；**全阶段整页锁滚**（竞速=泳道内滚；裁判=预览弹性内滚+裁判台固定下部；执行=执行泳道内滚+审计卡固定）；回显气泡超 2000 字预览截断（完整指令照发引擎）；执行阶段「↗ 打开执行会话」可在变更面板逐文件 diff/拒绝
- 实现：`src/shared/race.ts`（域模型/策略/产物/事件）+ `src/main/race/`（RaceOrchestrator 纯控制流状态机（依赖注入 RaceSessionHost）/ RaceManager 组合根桥 SessionManager+IPC+races.json / racePrompts 各阶段提示词）+ `src/renderer/src/store/raceStore.ts` + `components/race/`（RaceView/RaceCircuit/RaceLane/ArtifactsPreview/JudgePanel/RaceSetup/RoleTuneDialog/EliminateButton/modelCatalogs）；Composer ⚔ 入口；设计文档 `docs/大模型赛马方案.md`

## 五、关键实测结论（新对话必读的坑）

- kimi CLI 0.29.1 ACP：sessionCapabilities 仅 `{list, resume}`；`session/fork` 返回 -32601（SDK 有方法 ≠ agent 实现）；探针脚本 `scripts/probe-fork.mjs`
- kimi spawn 方式：PowerShell 执行策略拦 .ps1 shim，必须 `node <APPDATA>/npm/node_modules/@moonshot-ai/kimi-code/dist/main.mjs acp`（resolveKimi.ts 已封装；codex 同理 `@openai/codex/bin/codex.js`）
- 子进程用 `process.execPath + ELECTRON_RUN_AS_NODE=1`，dev/打包通用
- codex app-server 帧：ndjson、**无 `jsonrpc:"2.0"` 字段**；先 `initialize` 后必须发 `initialized` 通知
- codex wire_api 只剩 `responses`（chat 已删）→ 内置代理是必经之路；自定义 provider 无需登录（requiresOpenaiAuth=false）
- codex turnId 是字符串，客户端自增 int 做映射；turn/start 响应即返回，完成以 `turn/completed` 通知为准
- MiniMax `<think>` 内联在 content：Kimi/Omp/Opencode 三个 adapter 均接 ThinkSplitter 二次分流（opencode server 对 text part 不拆 think 标签，2026-07-29 补齐）
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
- **omp 实测坑（2026-07-29，本机 omp/17.1.8，详见 docs/probe-omp-findings.md）**：
  - ACP 运行时面无 approval 精细控制：`set_mode` 只认 plan/default（yolo/auto/write → Internal error）；auto/yolo 靠 spawn flag（`--approval-mode write` / `--auto-approve`），创建时定、中途切需重开
  - thinking 档位动态：无模型仅 off/auto；带 `--model` 后扩展出目录 thinking[] 精细档；spawn **必须带 --model**（否则无默认模型，prompt 秒报 Internal error）
  - 探针陷阱：设 `PI_CODING_AGENT_DIR` 指向空目录会把 models.yml/凭据一起隔离 → prompt 必败；适配器不设此变量
  - prompt 响应带真实 usage（inputTokens/outputTokens/totalTokens/cachedReadTokens），优于 usage_update 快照
  - tool_call 事件形态与 kimi ACP 完全同源（kind/locations/rawInput/content 嵌套），KimiAdapter 映射直接兼容；omp 对 headless 子代理（task）强制 yolo，主会话审批不约束它们（plan 模式例外：task 子代理被强制只读工具集）
  - omp 迭代快（fork 项目单一维护者主导）：版本 pin 17.1.8，设置页越线显契约漂移警告，异常优先回退基线版本
- **Electron 文件拖放**：必须在 window 级 preventDefault dragover/drop（否则拖文件导航到 file:// 且子元素 drop 不稳定触发）；Windows 下 dragover 还需显式设 `dataTransfer.dropEffect='copy'`
- **Tailwind CSS 变量色**：`err: 'var(--err)'` 字符串定义不支持 `/30` 透明度修饰符（类静默不生成退白边框）；withAlpha 函数式定义只在纯数字透明度时生成静态 color-mix，普通类保持原样 var()（卷入 --tw-*-opacity 变量 calc 会让全部边框退白）

## 六、代码地图

```
cyberslots/
├ src/shared/          types.ts(统一模型/设置/事件) ipc.ts(通道契约) presets.ts(provider预设)
├ src/main/
│  ├ index.ts          入口：portable data 重定向、窗口(titleBarOverlay)、单实例、防孤儿
│  ├ windowTheme.ts    配色×明暗→原生窗口颜色
│  ├ ipc.ts            IPC 注册（薄胶水，key 掩码在此）
│  ├ config/settings.ts    SettingsStore（safeStorage、迁移、dev seed .dev/secrets.json）
│  ├ config/ConfigWriter.ts kimi-home + codex-home 的 config.toml 生成
│  ├ engine/EngineAdapter.ts 引擎接口（prompt/cancel/setModel/setMode/fork?/compact?/steer?）
│  ├ engine/SessionManager.ts 会话中枢（fork/forkToEngine/steer/compact/markRead/通知/contextSeed）
│  ├ engine/changeTracker.ts + shadowGit.ts 变更台账与影子 git 快照（接受·回退 + 逐提问 marks 还原点，§4.19）
│  ├ engine/kimi/       KimiAdapter.ts resolveKimi.ts thinkSplitter.ts
│  ├ engine/codex/      CodexAdapter.ts rpc.ts(ndjson-rpc) resolveCodex.ts
│  ├ engine/opencode/   OpencodeAdapter.ts OpencodeServerHost.ts OpencodeEventHub.ts resolveOpencode.ts
│  ├ engine/omp/        OmpAdapter.ts(ACP同kimi基建+background回合+命令黑名单) resolveOmp.ts(CLI解析+快照+models目录)
│  ├ race/              RaceOrchestrator.ts(赛马状态机,依赖注入RaceSessionHost) RaceManager.ts(组合根,桥SessionManager+IPC+races.json) racePrompts.ts(各阶段提示词, §4.20)
│  ├ usage/providerQuota.ts 供应商套餐余量/余额（key探测+代查+TTL缓存，§4.16）
│  ├ terminal/TerminalService.ts 内嵌终端后端（@lydell/node-pty 真 PTY，按会话复用）
│  ├ proxy/AiServerHost.ts 内置代理托管（utilityProcess、动态端口、协议槽位）
│  ├ cron/              CronService.ts cronMatch.ts
│  ├ slash/slashService.ts 斜线命令候选扫描（引擎全局+项目级 skills/commands，只读）
│  └ fs/fsService.ts    工程树/预览/写入(边界检查)/git状态/openIn/拖放导入(importPaths)/粘贴图临时文件(saveTempAttachment)
├ src/renderer/src/
│  ├ i18n.ts            zh/en 字典 + useT()
│  ├ selections.ts      选区引用序列化/截断（selection 块注入 prompt）
│  ├ store/chatStore.ts 唯一状态源（事件折叠/队列/goal/effort/筛选/心跳/opencodeCatalog 懒加载）
│  └ components/        App Sidebar NewSessionView ChatView(含rail+心跳) Composer(功能区全家桶)
│                       ChipInput(contenteditable+文件chip) EngineIcon(引擎品牌SVG,currentColor随主题) SlashMenu(斜线命令补全弹层) OpencodeModelPicker(完整版选择器) SelectionChip(选区卡片+快照预览)
│                       TurnRail(回合导航刻度条, codex同款, §4.15)
│                       mission/(MissionControl看板 SessionCard卡面直批 cronNext, §4.18)
│                       UsageView(用量统计大窗, §4.16) UsageQuota(用量入口+悬浮小窗+余量行)
│                       TerminalPanel(xterm内嵌终端) MessageList(工具聚合组+活动指示器, §4.3) MessageItem(思考块/编辑卡/命令条/To-dos卡/FileTypeIcon) PermissionSheet PlanWidget
│                       UndoConfirmDialog(提问级回退确认弹窗, §4.19)
│                       race/(RaceView赛马全屏视图 RaceCircuit赛程HUD RaceLane泳道 ArtifactsPreview产物预览 JudgePanel裁判台 RaceSetup发起面板 RoleTuneDialog调参 EliminateButton二段确认✂ modelCatalogs目录hook, §4.20) + store/raceStore.ts
│                       SettingsView(全页) ScheduledView WorkspaceDialog ErrorBoundary
│                       workspace/(Panel FileTree(拖放导入) FilePreview(划选添加到对话) DiffView)
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
- kimi「Approve for this session」对同回合并发的第二个同名授权不生效（引擎侧行为）——可选做客户端侧会话内自动批准记忆
- Goal 状态与队列为内存态，应用重启丢失（可选持久化）
- ScheduledView 删除任务无二次确认（可复用侧栏二段确认模式）
- 打包版无应用图标、未签名（杀软误报风险，后期项）
- 旧会话（消息持久化功能之前创建的）历史为空，属历史数据非 bug

## 九、后续路线（未做，按优先级）

### P1 待做
- （✅ 已完成）diff 查看器 + 文件变更逐个/全部 接受·回退 — 见 §4.7
- @ 文件补全（commands.update 事件已透传，UI 未做）
- （✅ 已完成）slash 命令菜单（目录扫描式：引擎全局 + 项目级 skills/commands）— 见 §4.4
- 会话搜索（sqlite FTS 或简单全文）、导出 Markdown、会话重命名/置顶 UI（置顶字段已有）
- MCP 统一管理页（双引擎 config 同步）
- CLI 路径设置项（cliEntry 参数 adapter 已支持，设置页未暴露）
- 托盘、开机自启、全局快捷键、窗口记位、electron-updater

### P2 待做
- swarm 进度面板增强（模型/token/耗时列；依赖引擎事件面，可能需 fork）
- 成本仪表盘（usage 事件已有 costUsd 字段）
- 执行过程时间线
- （✅ 已完成）回退提问 — 见 §4.19（逐提问影子快照 + 消息截断 + contextSeed 重播，未用 codex fork/rollback 与 kimi 重放的旧设想）

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
