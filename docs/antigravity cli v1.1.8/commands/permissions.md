# 权限命令（/permissions）

> 在 TUI 内交互式管理你的细粒度 agent 权限规则。

## 概述

Antigravity CLI 使用一个细粒度权限引擎来保护你的工作站。虽然你可以在 settings 文件里手动配置这些规则，`/permissions` 命令打开一个交互式**权限管理器 TUI 面板**，让你实时查看、添加、编辑和删除规则。

关于权限引擎如何工作、支持的动作和手动配置，参见概念页《权限指南》（Permissions Guide）。[未提供]

## 交互式管理权限

打开权限管理器：

1. 在 prompt 框输入 `/permissions`。
2. 按 `Enter`。

```text
/permissions
```

## 导航与控制

权限管理器有三个面板：

### Scope Picker（作用域选择器）

选择你想编辑的配置作用域：

- **Project**：仅应用于当前活动项目的规则（若没有打开项目则禁用）。
- **Shared**：跨所有 Antigravity 产品共享的规则。
- **Global**：应用于你所有会话的全局规则。

用 `↑ ↓`（或 `j`/`k`）导航，`Enter` 选择，`Esc` 退出。

### Rule Viewer（规则查看器）

查看所选作用域配置的规则。

- 用 `→ ←`（或 `Tab`）在 allowlist、denylist、asklist 标签间切换。
- 用 `↑ ↓`（或 `j`/`k`）滚动规则。
- 按 `a` 添加新规则。
- 按 `e`（或 `Ctrl+G`）编辑高亮的规则。
- 按 `d`（或 `Backspace`）删除高亮的规则。
- 按 `Esc` 返回 Scope Picker。

### Add/Edit Rule（添加/编辑规则）

在输入框里输入或编辑规则。

- 规则必须遵循 `action(target)` 格式（如 `command(git)`）。
- 按 `Enter` 验证并保存规则。
- 按 `Esc` 取消。

## 逐步演练

以下是如何在 TUI 里实时查看、添加、编辑和删除规则。

### 1. 选择作用域并查看规则

运行 `/permissions` 时，你首先看到 Scope Picker。选 Global 管理全局规则，按 `Enter` 打开该作用域的 Rule Viewer。用 `→ ←` 在 allow、deny、ask 标签间切换。

### 2. 添加权限规则

要让 agent 自动运行 git 命令而不提示：

1. 在 Rule Viewer 里按 `a`，Add Rule 面板在底部打开。
2. 在输入框里输入 `command(git)`。
3. 按 `Enter`。规则被验证并保存。你返回 Rule Viewer，`command(git)` 现出现在你的 allowlist 里。

### 3. 编辑权限规则

若你想限制 agent 只能自动运行 `git diff`：

1. 在 Rule Viewer 里用 `↑ ↓` 高亮 `command(git)`。
2. 按 `e`（或 `Ctrl+G`）。输入面板打开，预填 `command(git)`。
3. 把文本改为 `command(git diff)`。
4. 按 `Enter` 保存。旧规则被新规则替换。

### 4. 删除权限规则

要移除规则、恢复为对这些动作提示：

1. 在 Rule Viewer 里高亮你想删的规则（如 `command(git diff)`）。
2. 按 `d`（或 `Backspace`）。
3. 规则立即从列表移除。

## 延伸阅读

- 权限指南（Permissions Guide）：安全模型、动作类型和通配符匹配。[未提供]
- 沙箱与安全：见 [`../agent-capabilities/sandbox.md`](../agent-capabilities/sandbox.md)。
- CLI 参考：见 [`../reference.md`](../reference.md)。

---

> **CyberSlots 集成备注**：权限规则格式为 `action(target)`（如 `command(git)`），分 allow/deny/ask 三表，作用域分 Project/Shared/Global。赛马若要免审批自动跑 shell，可预置 allowlist 规则，或直接 `--dangerously-skip-permissions` 全开（结合 sandbox 更安全）。这套权限与执行模式 `agentMode` 正交。
