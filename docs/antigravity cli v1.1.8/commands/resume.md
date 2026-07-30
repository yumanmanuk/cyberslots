# 续接命令（/resume）

> 浏览、搜索和续接过去的对话线程，或从命令行即刻恢复你上一个会话。

## 概述

Antigravity CLI 允许你维护多个进行中的开发线程。`/resume` 命令打开一个交互式**会话选择器 TUI 面板**来浏览和加载你的历史。你也可以用命令行标志直接从宿主终端续接会话。

## 交互式会话选择器

在 TUI 内打开会话选择器：

1. 在 prompt 框输入 `/resume`（或别名 `/switch`、`/conversation`）。
2. 按 `Enter`。

```text
/resume
```

### 1. 导航和搜索对话

会话选择器显示按时间排序（最新在前）的过去对话列表。

- **搜索**：开始输入即可按标题、预览文本或唯一 ID 即时过滤对话。
- **导航**：用 `↑ ↓` 滚动过滤后的列表。
- **翻页**：用 `← →` 在更旧的历史块间前后翻页。
- **选择**：高亮目标会话并按 `Enter` 加载它。
- **退出**：按 `Esc` 关闭选择器，返回活动 prompt。

### 2. 重命名对话

为保持历史有序，你可以在选择器内直接重命名对话：

1. 用 `↑ ↓` 高亮想重命名的对话。
2. 按 `F2`。底部打开输入框，预填当前标题。
3. 输入新名称并按 `Enter` 保存，或 `Esc` 取消。

### 3. 删除对话

清理过时线程：

1. 在列表中高亮目标对话。
2. 按 `Ctrl+Delete`。出现确认提示。
3. 按 `Enter`（或 `y`）确认删除，或 `Esc`（或 `n`）取消。

### 4. 从 Antigravity 2.0 导入

你可以导入并续接在 Antigravity 2.0 桌面应用里发起的活动线程：

1. 打开会话选择器时，按 `Tab` 从 CLI 标签切到 Antigravity 标签。
2. 高亮你想导入的桌面对话。
3. 按 `Enter`。出现确认提示 `[Import this? (y/n)]`。
4. 按 `Enter`（或 `y`）确认。CLI 把历史、上下文和工具轨迹克隆进你的终端会话。

## 命令行快捷方式

你可以在从宿主 shell 启动 `agy` 时绕过 TUI 选择器，直接续接会话。

### 快速续接上一个会话（-c / --continue）

即刻续接与当前工作区关联的最近一个对话：

```bash
agy -c
```

（替代写法：`agy --continue`）

### 续接指定会话（--conversation）

按唯一 ID 直接加载特定对话：

```bash
agy --conversation <conversation-id>
```

## 底层原理：会话缓存

当你用 `-c` / `--continue` 标志时，CLI 用一个**按工作区键控的本地缓存**解析目标会话。

### 缓存文件

- **位置**：`~/.gemini/antigravity-cli/cache/last_conversations.json`
- **格式**：一个 JSON map，把绝对工作区目录路径关联到其最近活动的对话 ID：

```json
{
  "/usr/local/google/home/username/Develop/my-project": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "/usr/local/google/home/username/Develop/another-repo": "f9e8d7c6-b5a4-3210-fedc-ba9876543210"
}
```

### 解析工作流

1. **启动**：你在 `/path/to/workspace` 运行 `agy -c`。
2. **查找**：CLI 读取 `last_conversations.json`，查键 `/path/to/workspace`。
3. **验证**：若找到 ID，CLI 查询后端确认该对话仍存在。
4. **加载**：
   - 若验证通过，加载该会话。
   - 若对话已被删除或键缺失，为该工作区开一个全新会话。

## 延伸阅读

- 管理对话：workspace scoping 和用 `/fork` 分支。[未提供]
- CLI 参考：见 [`../reference.md`](../reference.md)。
- 设置与快捷键。[未提供]

---

> **CyberSlots 集成备注（关键）**：`-c` 只按**工作区路径**解析会话，`last_conversations.json` 里 map 的键是路径、**不区分账号**。所以无感切号后**不能靠 `-c` 续接**——同一工作区切到另一账号时 `-c` 可能命中的是别人的 conversation-id，且后端验证会因账号不匹配失败或新建会话。CyberSlots 必须自建"任务 ↔ conversation_id"映射，切号后显式传 `agy --conversation <id>`。注意：conversation 归属账号，跨账号加载他号的 conversation 大概率不可行——无感切号更可能是"新账号 + 新对话 + 重放上下文摘要"，而非续接同一 conversation_id（此点仍需实测，见 integration.md §6.4/§10.1）。
