# Phase 0 Findings — 地基验证报告

> 日期：2026-07-26 · 环境：Windows 10 (19045) · node v20.19.2 · npm 10.8.2

## 结论

**架构地基全部验证通过**：`spawn kimi acp` → `@agentclientprotocol/sdk` ClientSideConnection（ndjson over stdio）→ initialize → session/new → session/prompt → 流式输出 → end_turn，真实模型（MiniMax-M3）2 秒级响应。KimiAdapter 可按此形状实现，无未知风险。

## 环境与安装

| 组件 | 版本 | 方式 |
|---|---|---|
| codex CLI | 0.145.0 | `npm i -g @openai/codex` |
| kimi CLI | 0.29.1 | `npm i -g @moonshot-ai/kimi-code`（node 22 engine warning，但运行正常） |
| ACP SDK | @agentclientprotocol/sdk 0.23.x | 项目依赖 |

注意：PowerShell 执行策略拦 `.ps1` shim；程序内 spawn 走 `node <APPDATA>/npm/node_modules/@moonshot-ai/kimi-code/dist/main.mjs acp`（`scripts/phase0-verify.mjs#resolveKimiSpawn` 即最终 App 的解析策略）。

## 端点探针结果（scripts/probe-endpoints.mjs / probe-kimi2.mjs）

| 组合 | 结果 |
|---|---|
| **minimax** `api.minimaxi.com/v1` + `MiniMax-M3` / `MiniMax-M2.7`（Bearer, chat/completions） | ✅ 200，thinking 以 `<think>…</think>` 内联在 content |
| minimax `api.minimax.io/v1`（国际站） | ❌ 401（key 是国内站的） |
| **kimi key** @ moonshot.ai / moonshot.cn / kimi.com/coding（chat + anthropic /messages；Bearer + x-api-key；默认 UA + claude-cli UA） | ❌ 全部 401 "invalid or expired" — **key 本身无效，非端点/协议/UA 问题** |

→ kimi 修复路径：换有效 key 后改 `.dev/secrets.json` 一行即可；provider 形状（`type="openai"`）已就绪。

## ACP 协议实测面（kimi CLI 0.29.1）

- **agentCapabilities**：loadSession=true；prompt image=true/audio=false/embeddedContext=true；mcp http+sse=true；sessionCapabilities = `{list, resume}`（无 fork/rollback，与方案预判一致）
- **authMethods**：terminal login（device-code flow，`--login`，可注入 KIMI_CODE_HOME）
- **session/new configOptions**：
  - `model`（select）：列出 config.toml 全部 model alias，当前值可切
  - `mode`（select）：`default`（手动审批）/ `plan`（只读）/ `auto`（全自主）/ `yolo`（自动批准但可提问）
- **实测 update kinds**：`agent_message_chunk`、`available_commands_update`、`config_option_update`
- **slash commands 透传**：compact, status, usage, mcp, tasks, help, check-kimi-code-docs, custom-theme, import-from-cc-codex, mcp-config, sub-skill(.consolidate/.review), update-config, write-goal
- **模型热切换**：`unstable_setSessionModel({sessionId, modelId})` 生效并推送 `config_option_update`（也可用 `setSessionConfigOption` id=model）
- **SDK 客户端方法面**（ClientSideConnection）：initialize / newSession / loadSession / **unstable_forkSession** / listSessions / unstable_deleteSession / resumeSession / closeSession / setSessionMode / unstable_setSessionModel / setSessionConfigOption / authenticate / unstable_listProviders / unstable_setProvider / prompt / cancel / extMethod / extNotification
  - → **sidechat 有原生入口**（unstable_forkSession），优于方案预判的"纯历史重放"

## 配置形状（已验证生效）

`KIMI_CODE_HOME` env 重定向配置目录（App 将用它隔离/托管配置）。config.toml：

```toml
default_model = "<alias>"
[providers.<name>]
type = "openai"            # kimi 与 minimax 都走 OpenAI chat completions（用户确认）
base_url = "..."
api_key = "..."
# custom_headers 子表可覆盖 User-Agent（本轮未需要）
[models."<alias>"]
provider = "<name>"
model = "<upstream-id>"
max_context_size = 204800
```

## 遗留事项

- [ ] **kimi key 无效** → 用户更换有效 key（改 `.dev/secrets.json`）
- [ ] MiniMax `<think>` 内联 → UI 需解析拆分 thinking 块（或后续开 reasoning_split）
- [ ] `unstable_forkSession` 行为实测（sidechat 前置，阶段 4）
- [ ] 工具调用/审批/AskUserQuestion 事件面实测（阶段 1 KimiAdapter 联调时补，需带工具的 prompt）
