# Antigravity CLI v1.1.8 文档（中文）

> 来源：Antigravity CLI 官方文档（`https://antigravity.google/docs/cli/*`），v1.1.8。
> 由用户从网页复制正文、逐篇翻译整理，供 CyberSlots 集成 agy 引擎时查阅。
> 复制自网页的噪音（标题后缀 `link`、代码块 `content_copy`、语言标签行 `text/bash/json`、跨页导航链接）已在整理时剔除。

## 目录（对齐官方左侧导航树）

| 分区 | 页面 | 本地文件 | 素材状态 |
|---|---|---|---|
| — | Overview | `overview.md` | ❌ 未提供 |
| — | Getting Started | `getting-started.md` | ❌ 未提供 |
| — | Installation & Auth | `installation-auth.md` | ✅ 已翻译（正文全：三平台安装 + keyring/SSH 认证） |
| — | Tutorial | `tutorial.md` | ❌ 未提供 |
| — | Using AGY CLI | `using-agy-cli.md` | 🟡 仅截图（前几轮） |
| — | Features | `features.md` | ❌ 未提供 |
| — | Gemini Migration | `gemini-migration.md` | ❌ 未提供 |
| — | Prompting | `prompting.md` | ❌ 未提供 |
| — | Headless mode | `headless-mode.md` | ✅ 已翻译（正文全 + Flag/状态值/CI 示例） |
| Artifacts | Overview | `artifacts/overview.md` | ❌ 未提供 |
| — | Conversations | `conversations.md` | ✅ 已翻译（正文全：工作区限定 + 续接 + /fork） |
| Agent Capabilities | Choose an execution mode | `agent-capabilities/execution-mode.md` | ✅ 已翻译（正文全） |
| Agent Capabilities | Subagents | `agent-capabilities/subagents.md` | ✅ 已翻译（正文全） |
| Agent Capabilities | Sandbox | `agent-capabilities/sandbox.md` | ✅ 已翻译（正文全 + 截图补齐） |
| Agent Capabilities | Permissions（概念页） | `agent-capabilities/permissions.md` | ❌ 未提供（命令页见 commands/permissions.md） |
| — | Projects | `projects.md` | ❌ 未提供 |
| Settings | Overview | `settings/overview.md` | ❌ 未提供 |
| — | AI Credits | `ai-credits.md` | 🟡 仅截图（前几轮） |
| Customizations | MCP | `customizations/mcp.md` | ❌ 未提供 |
| Customizations | Plugins & Skills | `customizations/plugins-skills.md` | ❌ 未提供 |
| Customizations | Status Line | `customizations/status-line.md` | ❌ 未提供（概念页；命令页见下） |
| Customizations | Window Title | `customizations/window-title.md` | ❌ 未提供（概念页；命令页见下） |
| Commands | Agents (/agents) | `commands/agents.md` | ❌ 未提供 |
| Commands | Code Search (/codesearch) | `commands/codesearch.md` | ❌ 未提供 |
| Commands | AI Credits (/credits) | `commands/credits.md` | ✅ 已翻译（截图正文全） |
| Commands | Diff (/diff) | `commands/diff.md` | ✅ 已翻译（正文全） |
| Commands | Permissions (/permissions) | `commands/permissions.md` | ✅ 已翻译（正文全） |
| Commands | Resume (/resume) | `commands/resume.md` | ✅ 已翻译（正文全） |
| Commands | Status Line (/statusline) | `commands/statusline.md` | ✅ 已翻译（正文全） |
| Commands | Window Title (/title) | `commands/title.md` | ✅ 已翻译（截图正文全） |
| Commands | Model Quotas (/usage, /quota) | `commands/usage.md` | ✅ 已翻译（截图正文全 + 分组周额度） |
| — | Best Practices | `best-practices.md` | ✅ 已翻译（正文全） |
| — | Troubleshooting | `troubleshooting.md` | ❌ 未提供 |
| — | Reference | `reference.md` | ✅ 已翻译（完整：斜杠命令 + 全部键位 + settings.json 配置表） |

图例：✅ 已翻译入库 ／ 🟢 素材完整待整理 ／ 🟡 部分（仅截图或被截断）／ ❌ 尚未提供

## 与 CyberSlots 集成的关联

集成分析主文档在 [`../antigravity-integration.md`](../antigravity-integration.md)。本目录是官方文档的中文留档，两者交叉引用。

> **重要机制修正（据 Best Practices 页）**：agy 有两套正交权限维度——
> - **执行模式** `agentMode`：`default`/`accept-edits`/`plan`（管文件编辑自动批准）
> - **工具权限** `toolPermission`：`request-review`/`proceed-in-sandbox`/`strict`（管写/bash/网络审批级别）+ `enableTerminalSandbox`
>
> stream-json `init.permission_mode` 里的 `request-review` 是 **`toolPermission`** 的值，不是执行模式。headless 全自动应同时设 `agentMode=accept-edits` + `toolPermission=proceed-in-sandbox`。
>
> **补充（据 Reference 页 settings.json 完整表）**：`toolPermission` 实际有 **4 个档位**：`request-review`（默认）/ `proceed-in-sandbox` / `always-proceed`（从不提示）/ `strict`（所有非只读工具都提示）。另有独立的 `artifactReviewPolicy`（`asks-for-review`/`agent-decides`/`always-proceed`）专管写代码审阅。headless 全自动可用 `toolPermission=always-proceed` 彻底免提示（或 `proceed-in-sandbox` + `enableTerminalSandbox` 保守）。
