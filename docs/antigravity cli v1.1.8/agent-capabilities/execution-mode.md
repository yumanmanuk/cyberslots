# 选择执行模式（Choose an execution mode）

> 控制 Antigravity CLI 在会话中修改文件或执行命令前是否暂停征询。

## 开始之前

- 安装 Antigravity CLI
- 有一个含源代码、可供编辑的活动项目仓库

## 可用模式

每种执行模式在"对话自主性"和"开发者监督"之间做不同的权衡。下表展示各模式下 Antigravity CLI 如何处理文件操作与规划。

| 模式 | 行为 | 最适合 |
|---|---|---|
| `default` | 修改或创建文件前暂停，进行交互式 diff 审阅。 | 标准开发、审阅敏感代码改动、谨慎重构。 |
| `accept-edits` | 自动批准文件编辑与创建（mkdir、touch、文件写入）。 | 快速原型、在可信代码上迭代、减少 prompt 打断。 |
| `plan` | 在写代码前，给 prompt 前置 `/plan` 指令前缀来分析并勾勒步骤。 | 探索陌生架构、设计复杂的多步骤特性。 |

> 注意：通过 `/permissions` 或 `--dangerously-skip-permissions` 配置的**工具权限规则**，在所有执行模式下都持续管辖 shell 命令（`run_command`）。

## 会话中循环切换执行模式

你可以在会话中途切换执行模式，无需打断活动任务或重启终端。

在 prompt 框内按 `Shift+Tab` 循环切换：`default` → `accept-edits` → `plan` → `default`。

观察 prompt 输入下方的状态栏指示器，确认当前模式（`[accept-edits]` 或 `[plan]`）。

> 提示：当 `default` 模式下 Antigravity CLI 因待确认的文件编辑而暂停时，你可以按 `Shift+Tab` 立即切到 `accept-edits` 模式，一次批准所有待处理的文件修改。

## 在 default 模式下审阅修改

在 `default` 模式（`request-review`）下，Antigravity CLI 会在把任何文件写入磁盘前暂停，渲染一个内联的、语法高亮的 diff 预览。

```bash
# 以默认交互审阅模式启动
agy
```

当出现待处理文件修改的提示时：

- 按 `y` 接受改动并把文件保存到磁盘。
- 按 `n` 拒绝编辑、保持现有文件不变。
- 按 `f`（KeyViewDiff）打开全屏、可滚动的 diff 审阅，带 3 行上下文和 hunk 分隔符。
- 按 `Ctrl+G` 在你的 `$EDITOR` 中打开文件手动调整。
- 在 prompt 框输入指令并按 `Enter`，拒绝该编辑并告诉 agent 换个做法。

### 新文件创建预览

当 Antigravity CLI 创建全新文件时，确认面板显示一个"仅新增"的 diff 预览，带专门的 "Create file" 标题和明确的 allow/deny 提示：

```text
Create file: src/utils/formatter.ts
Allow create this file? [y/n/f]
```

## 用 accept-edits 模式自动批准编辑

当你希望 Antigravity CLI 在文件系统上长时间不间断工作、不为每次文件修改暂停时，选择 `accept-edits` 模式。

```bash
# 直接以 accept-edits 模式启动
agy --mode=accept-edits
```

此模式下，所有标准文件读取、创建和替换操作（`write_to_file`、`replace_file_content`、`multi_replace_file_content`）自动运行。会话中派生的**子代理也继承 accept-edits 设置**，防止后台文件写入排队等待手动批准。

## 用 plan 模式在编辑前分析任务

在进行复杂重构、多文件架构改动或陌生代码库调查时，使用 `plan` 模式。

```bash
# 直接以规划模式启动
agy --mode=plan
```

当 `plan` 模式经 `Shift+Tab` 循环或 `--mode` 标志激活时，CLI 自动给你的 prompt 前置 `/plan` 指令前缀。agent 用只读工具（`code_search`、`grep_search`、`view_file`）调查相关文件，并在写代码前给出一份结构化执行大纲供你批准。

## 持久化或覆盖你的默认模式

你可以永久设置跨会话的启动执行模式，或为特定调用临时覆盖它。

### 使用交互式设置面板

会话中途打开交互式设置面板，检视或更新默认配置：

```bash
/settings
```

用 `↑ ↓` 导航到 Agent Mode，按 `Enter` 或 `Space` 选择默认值（`default`、`accept-edits` 或 `plan`），按 `Ctrl+S` 保存。修改此选项会立即同步你的运行时 CycleMode。

### 在 settings.json 里设置 agentMode

直接在用户或项目配置文件中设置 `agentMode`：

```json
{
  "agentMode": "accept-edits"
}
```

CLI 在启动时从 `~/.gemini/antigravity-cli/settings.json` 加载此文件，应用你选择的基线执行模式。

### 命令行标志覆盖

传入 `--mode` 标志，为单次终端运行临时覆盖你持久化的默认模式：

```bash
# 覆盖 settings.json，以规划模式运行
agy --mode=plan
```

## 常见错误

| 错误 | 为何失败 | 修复 |
|---|---|---|
| 期望 `sandbox` 出现在 `Shift+Tab` 循环里 | sandbox 是操作系统级的隔离**权限**设置，不是执行模式 | 在 `/permissions` 内配置 sandbox 自动批准规则 |
| 使用遗留的 `/planning` 或 `/fast` 命令 | 这些残留命令在 1.1.0 已移除 | 按 `Shift+Tab` 循环模式，或在 prompt 前输入 `/plan` |
| 传入 `--permission-mode` | agy 用 `--mode`（`--mode=accept-edits` 或 `--mode=plan`）做执行覆盖 | 运行 `agy --mode=accept-edits` 或查看 `agy --help` |

---

> **CyberSlots 集成备注**：赛马全自动应以 `agy --mode=accept-edits` 启动（子代理继承），并配合 `toolPermission` 管 shell 命令。`--mode` 才是执行模式标志，`--permission-mode` 无效。stream-json `init.permission_mode` 报的是 `toolPermission` 值（`request-review`），不是执行模式。
