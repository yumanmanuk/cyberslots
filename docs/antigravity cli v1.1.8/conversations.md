# 管理对话（Managing conversations）

> 续接此前的开发线程、把活动历史限定到本地工作区、fork 对话以试验替代架构。

## 工作区限定（Workspace scoping）

为保持上下文清洁，Antigravity CLI 把对话历史**直接限定到你当前的工作目录**。当你从某个特定目录启动 `agy` 时，agent 只显示并续接与该特定本地仓库或子目录关联的会话。

这防止上下文污染，确保 agent 的语义记忆和 token 上限始终只聚焦在相关的代码库上。

## 续接会话（Resuming sessions）

你随时可以回到此前的对话，去继续一项实现、打磨一个方案，或从被中断的会话里恢复。

Antigravity CLI 同时支持交互式的 **Session Picker TUI** 浮层，以及直接的命令行 flag（`agy -c` / `agy --continue`）来基于你的活动工作区即时续接线程。

交互式选择器、键盘快捷键，以及目录限定的会话缓存如何工作的完整说明，见专门的 **Resume Command Guide**（[`commands/resume.md`](commands/resume.md)）。

## 用 `/fork` 分支

在工程化一个复杂特性时，你可能想探索多个设计备选而不丢失进度。`/fork` 命令支持安全、并行的试验。

```
/fork
```
（别名：`/branch`）

`/fork` 命令把你到当前回合为止的**整个对话历史**克隆进一个新的、独立的会话。

### Forking 工作流

1. 在 prompt 面板里输入 `/fork` 并按 `Enter`。
2. CLI 分配一个新的唯一会话 ID，并复制你现有的工作区状态和 agent 线程。
3. 你的活动终端立即切换到新分支。
4. 若试验失败，运行 `/resume` 恢复到你原来的、稳定的对话分支。

> 💡 **分支的文件系统**：Forking 克隆的是**对话线程，不是你本地的 git checkout**。要在并行 fork 期间彻底隔离文件，请用 git 分支，或在测试对照方案前 stash 本地改动。

## 下一步

探索 agent 如何处理复杂的异步操作和并行任务：

- **Background Tasks & Subagents**：监控子代理、处理快速路径审批。
- **Settings, Rendering & Keybindings**：配置渲染缓冲、覆盖 JSON 偏好。
- **Permissions & Sandbox**：管理安全配置和系统命令清单。

---

> **CyberSlots 集成备注（会话续接机制，切号不丢上下文的关键）**：
> - **会话按工作目录限定**：`agy -c`/`--continue` 只续接「当前 cwd 关联」的会话。CyberSlots 每个赛马任务须固定同一 cwd，否则续接取不到。
> - **`-c` 只能接"最近一条"，不区分账号**：切号后若直接 `-c` 可能接错会话。跨账号续接必须靠**自建「任务 ↔ conversation_id」映射 + 显式 `--conversation <id>`**（见 [`headless-mode.md`](headless-mode.md)、[`commands/resume.md`](commands/resume.md)）。
> - **`/fork`（别名 `/branch`）克隆的是对话线程，非 git 工作区**——赛马「多引擎并行同一任务」若复用，需注意文件层用 git 分支/worktree 隔离，避免多分支写同一 checkout 互相踩踏。
> - `/fork`、`/resume` 均为**交互式命令**；headless 侧只有 `-c`/`--conversation` 可用于程序化续接。
