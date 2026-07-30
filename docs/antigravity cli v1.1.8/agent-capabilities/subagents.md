# 后台任务与子代理（Background tasks & subagents）

> 把缓慢的构建、多文件代码生成和研究扫描委派给并行后台 agent，同时保持你活动的编程流。

> Antigravity 2.0 & Hub 文档：关于核心平台能力、子代理生命周期状态图、代理间消息传递和嵌套深度限制，参见 Antigravity 2.0 Subagents Documentation。[未提供]

## 异步执行模型

为最大化开发速度，Antigravity CLI 采用多线程异步执行架构。主 agent 不会在长时间构建、大规模代码库搜索扫描或复杂多文件编辑期间锁死终端会话，而是把这些操作委派给并行的**子代理（Subagents）**或**后台任务（Tasks）**。

这种委派模型确保你永远不必等待高延迟的 AI 处理。你可以继续起草代码、提交 prompt 或检查文件，同时多个自主后台线程并行执行验证任务。

## 管理 agent：/agents 面板

活动的 agent 层级和自定义 agent 选择菜单，通过交互式 Agent 管理面板（`/agents`）完全透明、可管理。

### 打开面板

在 prompt 输入 `/agents` 并按 `Enter` 打开交互式 Agent 管理面板。

### 面板概览

面板显示所有活动、已完成、已终止或失败的后台 agent 的实时清单：

- **Identifier**：唯一的目标子代理 ID。
- **Role**：agent 的专门角色（如"Codebase Researcher"或"Database Debugger"）。
- **State**：实时状态指示（running、done、killed 或 error）。
- **Step**：当前正在执行的工具或推理步骤的实时摘要。

> 提示：你也可以在此面板选择并切换自定义 agent（或 fork 对话）。自定义 agent 发现和面板键位的完整细节见 `/agents` 命令参考。

### 自定义 Agent（Markdown 格式）

除内置 agent 外，CLI 会自动发现以 Markdown 格式（`.md`）定义、带 YAML frontmatter 的自定义 agent：

- **工作区 Agent**：`.agents/agents/<name>.md` 或 `.agents/agents/<name>/agent.md`
- **全局 Agent**：`~/.gemini/config/agents/`

当自定义 agent 在其 YAML frontmatter 里设了 `subagent: true`，主 agent 就能通过 `invoke_subagent` 调用它。你也可以在 `/agents` 面板菜单里直接把自定义 agent 选为你的主 agent。

关于完整 schema、frontmatter 参数和代码示例，参见 Custom Subagents Specification。[未提供]

### 深度监控

要检查某个后台 agent 的内部推理、思考和日志：

1. 打开 `/agents` 面板，用 `↑ ↓` 高亮目标 agent。
2. 按 `Enter` 打开子代理详情视图（Subagent Detail View）。
3. 此全屏视图揭示子代理的整个推理日志，包括其私有内部思考、工具调用和执行输出。
4. 按 `Esc` 退出，返回主 Agent 管理列表。

## 用 /tasks 监控后台任务

对于非 agent 型的后台操作——如直接 shell 命令、测试套件或经 `/btw` 发起的简单后台查询——使用 `/tasks` 命令。

```text
/tasks
```

任务跟踪列表让你：

- 跟踪标准的非交互后台进程。
- 用 `↑ ↓` 选择任务并按 `Enter` 查看 stdout 日志。
- 安全终止失控的终端进程。

## 键盘工效学

为减少子代理需要手动交互或工具授权时的上下文切换摩擦，Antigravity CLI 集成了高效率快捷路径。

### "传送"导航（Alt+J）

当子代理遇到需要批准的工具（如写文件或运行数据库迁移）时，状态栏通知会闪烁。

在主 prompt 面板内按 `Alt+J`，即可从当前对话立即"传送"到下一个等待你批准的子代理的详情视图。确认或拒绝该动作后，按 `Esc` 传送回你的主线程。

### "快速路径"确认（Ctrl+K）

要不离开活动工作区即刻授权某个 agent 动作：

1. 看你活动 prompt 框正上方显示的内联状态通知。它摘要了待处理动作（如 `Subagent 12 asks to run "npm test"`）。
2. 按 `Ctrl+K` 即刻批准该待处理的快速路径动作，无需切换面板或打开浮层。

## 延伸阅读

- 设置、渲染与快捷键。[未提供]
- 权限与沙箱：见 [`sandbox.md`](./sandbox.md) 与 [`../commands/permissions.md`](../commands/permissions.md)。
- 插件与技能。[未提供]

---

> **CyberSlots 集成备注**：赛马场景下我们不依赖 `/agents`/`/tasks` 交互面板（那是 TUI 的）；但"子代理继承 accept-edits"这条对 headless 全自动很关键。自定义 agent 的发现路径（`.agents/agents/`、`~/.gemini/config/agents/`）未来若要给 agy 引擎预置专用角色可复用。
