# CLI 参考（Reference）

> 可扫读的表格，列出所有 TUI 斜杠命令、默认键盘快捷键和 JSON 配置参数。

## 核心斜杠命令

在 prompt 输入框内输入 `/` 打开预输入命令选择菜单。

| 命令 | 分类 | 别名 | 执行用途 |
|---|---|---|---|
| `/add-dir <path>` | Utilities | — | 把一个目录路径加入当前工作区。 |
| `/agents` | Tools & Tasks | — | 打开 Agent 管理面板，切换自定义 agent、监控后台子代理。 |
| `/artifact` | Tools & Tasks | — | 打开 Artifact 审阅面板。 |
| `/btw <query>` | Utilities | — | 在后台问一个旁支问题，不打断主对话。 |
| `/clear` | Utilities | `/new` | 清屏并重置当前对话上下文。 |
| `/config` | Configurations | `/settings` | 打开交互式设置编辑器浮层。 |
| `/context` | Utilities | — | 打开上下文用量可视化面板。 |
| `/copy` | Utilities | — | 把上一条 agent 回复复制到系统剪贴板。 |
| `/credits` | Account | — | 查看剩余 G1 credits 及购买链接。 |
| `/diff` | Utilities | — | 打开交互式 Diff 查看器，查看改动、回合和提交。 |
| `/exit` | Core | `/quit` | 关闭 TUI 会话并恢复宿主 shell。 |
| `/fast` | Configurations | — | 启用快速模式（跳过推理计划）以做快速动作。 |
| `/feedback` | Utilities | — | 打开反馈提交面板。 |
| `/fork` | Conversations | `/branch` | 把当前对话线程克隆成一个新的并行会话。 |
| `/help` | Utilities | — | 打开显示命令和快捷键的帮助面板。 |
| `/hooks` | Tools & Tasks | — | 浏览活动的预处理/后格式化脚本 hook。 |
| `/keybindings` | Configurations | — | 打开交互式键盘快捷键编辑器。 |
| `/logout` | Account | — | 断开你的档案连接，并从安全 keyring 中清除认证令牌。 |
| `/mcp` | Tools & Tasks | — | 打开 MCP（Model Context Protocol）服务器管理器。 |
| `/model` | Configurations | — | 选择你偏好的推理模型（跨会话持久化）。 |
| `/open <path>` | Utilities | — | 强制在你的默认系统编辑器中打开该路径。 |
| `/permissions` | Configurations | — | 打开交互式工具权限管理面板。 |
| `/planning` | Configurations | — | 为复杂工程任务启用多回合计划生成模式。 |
| `/rename <name>` | Conversations | — | 重命名当前会话线程。 |
| `/resume` | Conversations | `/switch`, `/conversation` | 打开对话选择器浮层，选择并加载之前的线程。 |
| `/rewind` | Conversations | `/undo` | 把对话历史回滚到之前的某条消息。 |
| `/skills` | Tools & Tasks | — | 浏览已加载的本地和全局 Agent Skills。 |
| `/statusline` | Configurations | — | 打开状态栏自定义浮层。 |
| `/tasks` | Tools & Tasks | — | 打开任务管理面板，监控后台 shell 执行日志。 |
| `/title [on/off]` | Configurations | — | 开关或设置终端窗口标题更新。 |
| `/usage` | Utilities | `/quota` | 显示模型配额用量。 |

## 默认键盘快捷键

映射全局、prompt、导航和审批操作的键盘快捷键命令。

### 全局控制

无论当前聚焦哪个面板、浮层或 prompt，这些热键始终生效。

| 键 | TUI 命令 | 行为 |
|---|---|---|
| `Esc` | `cli.escape` | 关闭活动面板、停止活动流、或清空空 prompt。 |
| `Ctrl+C` | `cli.exit` | 终止 CLI 会话（若 agent 正在工作则提示确认）。 |
| `Ctrl+D` | `cli.exit` | 退出 CLI 会话（仅当 prompt 框为空时）。 |
| `Ctrl+L` | `cli.clear_screen` | 刷新并清空视觉终端缓冲区。 |

### Prompt 焦点键

在 prompt 框内写指令时生效。

| 键 | TUI 命令 | 行为 |
|---|---|---|
| `Enter` | `prompt.submit` | 把你的 prompt 或当前菜单选择提交给 agent。 |
| `Shift+Enter` / `Ctrl+J` | `prompt.newline` | 插入一个干净换行而不提交。 |
| `Ctrl+V` | `prompt.paste` | 把图形媒体文件或剪贴板块粘贴进 prompt。 |
| `Ctrl+O` | `prompt.toggle_trajectory` | 展开或折叠详细的工具推理输出。 |
| `Ctrl+R` | `prompt.open_review` | 打开 Artifact 审阅面板。 |
| `Ctrl+G` | `prompt.external_editor` | 启动你的默认 `$EDITOR` shell 来撰写 prompt。 |
| `Alt+J` | `prompt.teleport_agent` | 立即把焦点切到下一个等待确认的子代理。 |
| `Ctrl+K` | `prompt.fast_approve` | 立即批准状态提醒里列出的待处理子代理动作。 |
| `Ctrl+A` | `prompt.cursor_start` | 把 prompt 插入光标移到行首。 |
| `Ctrl+E` | `prompt.cursor_end` | 把 prompt 插入光标移到行尾。 |
| `Ctrl+Z` | `prompt.undo_text` | 撤销上一次编辑。 |
| `Ctrl+Shift+Z` | `prompt.redo_text` | 重做上一次被撤销的文本操作。 |
| `Ctrl+D` | — | 向前删除（仅当 prompt 框非空时）。 |

### 导航与滚动

在选择面板、菜单和可滚动文本框内使用。

| 键 | TUI 命令 | 行为 |
|---|---|---|
| `↑` / `↓` | `navigation.up` / `navigation.down` | 上/下滚动高亮选择一项。 |
| `PgUp` / `Shift+↑` | `navigation.page_up` | 活动文本视口向上滚动一页。 |
| `PgDn` / `Shift+↓` | `navigation.page_down` | 活动文本视口向下滚动一页。 |
| `←` / `→` | `navigation.left` / `navigation.right` | 在多页结构里翻页（如会话选择器）。 |
| `Tab` | `navigation.tab` | 确认高亮的斜杠命令自动补全选项。 |

### 工具确认

在确认提示期间生效。

| 键 | TUI 命令 | 行为 |
|---|---|---|
| `y` | `confirm.yes` | 授权所提议的工具、命令或当前 artifact。 |
| `n` | `confirm.no` | 拒绝所提议的工具、命令或当前 artifact。 |
| `A` | — | （在 Review 面板内）一键批准所有已生成的 artifact（内置快捷键）。 |

## JSON 配置参数（settings.json）

主要设置项的键名、数据类型、系统默认值和可选参数。

### settings.json 示例

```json
{
  "colorScheme": "tokyo night",
  "altScreenMode": "always",
  "toolPermission": "request-review",
  "notifications": true,
  "enableTerminalSandbox": true
}
```

| 键名 | 类型 | 默认值 | 参数特性与选项 |
|---|---|---|---|
| `colorScheme` | string | `"terminal"` | 配色主题：`"light"`、`"solarized light"`、`"colorblind-friendly light"`、`"dark"`、`"solarized dark"`、`"colorblind-friendly dark"`、`"tokyo night"`，或 `"terminal"`（继承原生 shell 配色）。 |
| `altScreenMode` | string | `"default"` | 屏幕缓冲区使用：`"default"`（自适应内联/备用屏）、`"always"`（强制备用屏缓冲区）、`"never"`（强制内联顺序输出）。 |
| `toolPermission` | string | `"request-review"` | 全局安全预设：`"request-review"`（写/bash/web 工具时提示）、`"proceed-in-sandbox"`（在沙箱内自动放行）、`"always-proceed"`（从不提示）、`"strict"`（所有非只读工具都提示）。 |
| `artifactReviewPolicy` | string | `"asks-for-review"` | 代码审阅策略：`"asks-for-review"`（写代码前总是提示）、`"agent-decides"`（动态提示）、`"always-proceed"`（从不提示）。 |
| `notifications` | boolean | `false` | 任务完成时发出系统桌面通知和终端铃声。 |
| `showTips` | boolean | `true` | 在生成回合期间于 prompt 面板上方显示 agent 使用提示。 |
| `showFeedbackSurvey` | boolean | `true` | 任务完成时定期显示质量反馈问卷。 |
| `editor` | string | `"auto"` | 目标文本编辑器：`"auto"`（查询系统 `$EDITOR`）、`"vim"`、`"emacs"`，或自定义文本标签。 |
| `allowNonWorkspaceAccess` | boolean | `false` | 允许 agent 的文件读写工具越出已识别的 Git/工作区根目录。 |
| `enableTerminalSandbox` | boolean | `false` | 把 agent 启动的所有本地执行命令限制在 OS 隔离环内。 |
| `useG1Credits` | boolean | `false` | 仅外部构建。计划额度耗尽后用个人 AI credits 做模型调用。 |
| `enableTelemetry` | boolean | `true` | 允许采集指标并把崩溃日志上报以改进工具可靠性。 |
| `verbosity` | string | `"high"` | 视觉详略级别：`"high"`（渲染完整思考和工具输出）或 `"low"`（仅显示最小视觉进度指示）。 |
| `runningLightSpeed` | string | `"medium"` | 运行灯进度动画速度：`"fast"`、`"medium"`、`"slow"`、`"off"`。 |

## 下一步

- **Permissions & Sandbox**：强制命令行隔离规则。
- **Plugins & Skills**：创建你自己的自定义技能斜杠命令。
- **Installation & Auth**：更新你的 CLI 安装。

---

> **CyberSlots 集成备注**：
> - `/logout` 明说「从安全 keyring 清除认证令牌」——与本项目实测的 keyring 认证真源一致，反证 CyberSlots 直接 `CredWrite` keyring 切号的可行性。
> - `toolPermission` 有 4 个档位（比之前掌握的多一个 `always-proceed`）；headless 全自动可用 `always-proceed`（从不提示）或 `proceed-in-sandbox`（配 `enableTerminalSandbox`）。
> - `useG1Credits` 仅「外部构建」可用——与额度调度相关，需确认 agy CLI 是否属「外部构建」而暴露此开关。
> - `/usage`（别名 `/quota`）显示模型配额用量——交互态额度信号来源，但本项目额度调度仍走 cockpit 链路（零消耗、扫全账号）。
