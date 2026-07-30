# Antigravity CLI 最佳实践

> 掌握工作流、prompt 架构与本地配置选择，在保持稳健控制的同时最大化 agent 速度。

## 建立验证闭环（verification loops）

确保自主 agent 做出可靠、正确修改的最有效方式，是给 agent 一个本地验证机制（如单元测试、构建命令或格式化脚本）。

在让 agent 实施代码改动之前：

1. 确保工作区目录已备好测试套件。
2. 如果没有测试，先让 agent 写一个标准的测试块。
3. agent 提出代码后，指示它运行本地测试命令来验证工作。
4. 观察 agent 执行命令，并让它根据测试输出自动迭代。

```text
> Implement feature X in main.py. Run npm test afterward to verify the build.
```

## 先探索，再规划，后执行

自主本地 agent 在把复杂改动拆分为独立的**探索、规划、执行**三个阶段时，准确度最高。

- **探索**：在写任何改动之前，先让 agent 解释目标代码库如何解决某个问题，或某个接口定义在哪里。
- **规划**：请求一份实施计划。agent 会在一个"实施计划 artifact"里列出目标文件、所需依赖和逻辑覆盖点。
- **执行**：一旦你批准了这份结构化计划，指示 agent 应用编辑。

```text
> Explore how our router resolves `/docs/:page`. Write down an implementation plan to add `/docs/best-practices`.
```

## 丰富你的 prompt 上下文

给本地 agent 高保真的指示，以收窄推理边界、降低 token 开销。

### 目标文件自动补全

在 prompt 输入框内输入 `@` 触发"交互式路径建议"浮层。高亮并选择一个路径，会把工作区文件的绝对路径直接导入你的 prompt，帮助 agent 精准定位代码搜索。

### 附加视觉证据

调试视觉 UI 问题、渲染 bug 或前端布局不一致时，截图或录屏后复制，在 prompt 输入框内按 `ctrl+v` 附加。agent 会参考该媒体文件来诊断问题。

## 配置你的工作区环境

优化本地工作站的规则与安全边界，以匹配你的工程流程。

### 编写代码库规则文件

在工作区根目录创建 `GEMINI.md` 或 `AGENTS.md` 文件，勾勒具体的目录规范、样式范式、测试命令参数和废弃警告。agent 在启动时会自动解析这些规则，并在建议改动前先参考它们。

### 建立结构化权限

依据项目风险级别，在 `~/.gemini/antigravity-cli/settings.json` 中调优安全屏障：

- **`request-review`（默认）**：在执行任何写操作、bash 命令或远程网络调用之前提示你。
- **`proceed-in-sandbox`**：把所有终端执行限制在一个安全沙箱隔离环内。安全命令自动执行，风险命令则提示审查。
- **`strict`**：对所有非读操作总是提示，提供完整的逐行透明度。

```json
{
  "toolPermission": "proceed-in-sandbox",
  "enableTerminalSandbox": true
}
```

## 主动管理 TUI 会话

用主动的会话导航工具，从工程死胡同中恢复，或纠正 agent 的中途循环。

### 尽早纠偏（esc）

如果你看到 agent 执行了错误的搜索模式，或写出偏离你意图的代码，立即按全局逃生键 `esc` 中断本回合，重新获得一个干净 prompt 的焦点。

### 用 /rewind 回退历史

如果 agent 连续做了几处改动、引入了构建错误，你不必丢弃整个会话。输入 `/rewind`（或 `/undo`）把对话线程回滚到之前的稳定检查点。

### 用 /fork 分支实验

如果你不确定最佳实现路径：

1. 到达一个稳定的基线线程。
2. 输入 `/fork` 生成一个重复的并行会话。
3. 在分支会话里测试你的推测性代码改动。
4. 如果方案失败，运行 `/resume` 切回稳定的主分支。

## 自动化与脚本化

Antigravity CLI 设计为可在标准 shell 管道工具中无缝运行。

### 运行非交互命令（-p）

要自动化快速查询、或把 agent 集成进 git hook，使用一次性 prompt 标志 `-p`：

```bash
agy -p "Review this git diff and draft a conventional commit message" --cwd $(pwd)
```

### 用并行子代理扇出（fan out）

对于大规模扫描或多文件重构，指示主 agent 派生并发的后台子代理（subagents）。agent 管理器会自主处理后台线程，同时你继续在主屏幕上工作。

## 相关资源

- 设置、渲染与快捷键（Settings, Rendering & Keybindings）。[未提供]
- 权限与沙箱（Permissions & Sandbox）：见 [`agent-capabilities/permissions.md`](./agent-capabilities/permissions.md)。
- 插件与技能（Plugins & Skills）：创建你自己的自定义斜杠命令。[未提供]

---

> **CyberSlots 集成备注**：本页坐实了 `toolPermission` 的三档取值（`request-review`/`proceed-in-sandbox`/`strict`）与 `enableTerminalSandbox` 字段，二者写在 `~/.gemini/antigravity-cli/settings.json`。这与"执行模式"`agentMode`（`default`/`accept-edits`/`plan`）是两套正交维度——headless 全自动跑赛马应同时配置。
