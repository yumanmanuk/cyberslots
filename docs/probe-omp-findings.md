# probe-omp-findings.md — oh-my-pi (omp) ACP 接入契约地面真值

探针脚本：`scripts/probe-omp.mjs`；实测版本 **omp/17.1.8**（Windows x64 原生 exe，
`C:\Users\<user>\AppData\Local\omp\omp.exe`，安装器 `irm https://omp.sh/install.ps1 | iex`）。
运行时间 2026-07-29。**无 API 凭据环境**（`omp models --json` 返回 0 条），故 prompt 事件流
（tool_call / chunk 形态）未能实测，按 pi 系同源 ACP surface 实现并标注「待凭据验证」。

## 1. 运行形态

- `omp acp`：ACP JSON-RPC over stdio（ndjson，LF 分帧），与 kimi 完全同源 → **OmpAdapter 复用 KimiAdapter 的 `@agentclientprotocol/sdk` 基建**（ClientSideConnection + ndJsonStream）。
- Windows 原生单 exe，**不依赖 bun/node**（与计划设想不同，更简单）。spawn 直接用 exe 路径，无需 ELECTRON_RUN_AS_NODE。
- 会话隔离：`PI_CODING_AGENT_DIR` env 指定 session 存储目录（探针用临时目录做只读探测）。

## 2. initialize 能力声明（实测）

```
agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "17.1.8" }
authMethods: [{ id: "agent", ... 用 ~/.omp 现有凭据 }]
agentCapabilities:
  loadSession: true
  promptCapabilities: { embeddedContext: true, image: true }
  sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }
  mcpCapabilities: { http: true, sse: true }
```

结论：**原生 fork / resume / loadSession 全部可用**（无需 kimi 式历史重放降级）。

## 3. 权限模式 / 思考档（关键差异）

ACP `session/new` 返回的 configOptions 只有两项：

| optionId | 值域（实测） | 说明 |
|---|---|---|
| `mode` | `default` / `plan` | plan = 只读规划模式（写 markdown 计划，不改代码） |
| `thinking` | `off` / `auto` **+ 当前模型的 thinking[] 精细档** | ⚠️ 二次实测修正：带 `--model` spawn 后值域动态扩展（如 deepseek → off/auto/high/max，currentValue 取模型默认）；无模型时仅 off/auto |

- `session/set_mode`：仅 `plan` / `default` 成功；`yolo`/`auto`/`write`/`always-ask` → **Internal error**。
- `session/set_config_option(thinking, "high")` → **Invalid params**（thinking 只吃 off/auto）。

因此，approval 精细控制与思考精细档 **不在 ACP 运行时面，只能 spawn flag 定**（`omp acp` 前缀 CLI flag）：
- `--approval-mode=always-ask|write|yolo`、`--auto-approve`
- `--thinking=off|minimal|low|medium|high|xhigh|max|auto`
- `--model=<slug>`、`--tools=<csv>`、`--no-tools`

### OmpAdapter 的模式映射（据此定）

| cyberslots PermissionMode | spawn flag | 运行时 set_mode |
|---|---|---|
| `default` | `--approval-mode always-ask`（触发 request_permission 弹卡） | `default` |
| `plan` | （默认 always-ask） | `plan`（只读，赛马只读角色用） |
| `auto` | `--approval-mode write`（自动批准写） | 无运行时途径 → set_mode `default` |
| `yolo` | `--auto-approve` | 无运行时途径 → set_mode `default` |

- 中途切换：`plan <-> default` 走 `session/set_mode`（ACP 支持）；切 auto/yolo 需重启进程（第一版降级为 set_mode default + 记录，自动批准靠 spawn flag 在创建时定）。
- **thinking/effort**：ACP 面只有 off/auto。cyberslots effort 参数映射：非空且非 off → `auto`，off → `off`（通过 set_config_option）。精细档（low/medium/high/xhigh/max）经 spawn `--thinking` flag 定，赛马 per-role effort 若需精细档由 spawn flag 承载；第一版赛马 omp effort 档给 `off`/`auto` 两档即可（auto 本身自动分档，语义合理）。

## 4. 模型目录

- `omp models --json`：无凭据时返回 0 条（需先 `omp auth` / 配 env key，或 `omp models refresh`）。
- OmpCatalog 实现：解析 `omp models --json`（数组或 `{models|data}`），字段 provider/id(slug)/efforts/thinkingLevels/cost 等；**空目录时退回「引擎默认」**（同 opencode 空目录处理）。
- model 选择：spawn `--model <slug>`（安全）；运行时切换尝试 `set_config_option(model)` 失败降级（同 kimi 双路径）。

## 5. update 通知类型（实测，与 kimi 同源）

`current_mode_update` / `config_option_update` / `available_commands_update` / `session_info_update`。
prompt 未跑（无凭据），但 pi 系 ACP surface 与 kimi 一致，预期含：
`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`。
→ **复用 KimiAdapter 的 onSessionUpdate 映射**，tool_call 的 kind/locations/content(diff) 字段同 ACP spec。

## 6. 斜杠命令（available_commands_update 实测节选）

`model / fast / computer / vision / prewalk / advisor / export / dump / share / browser / todo / session / jobs / usage / stats / ch…`

→ 需 GUI 语境黑名单过滤：`share`（发加密链接上公网）、`export`（导 HTML）、`stats`（起本地 dashboard）、`computer`（桌面控制）、`browser`、`join`/`collab` 等。白名单保留 `model`/`todo`/`usage`/`session` 等。

## 7. 特殊语义（据能力面推断，待凭据验证）

- **subagent（task 工具）/ 后台 jobs**：`jobs` 斜杠命令存在 → 异步作业会在回合后注入。OmpAdapter 需把非 prompt 发起的自发回合按 `stopReason='background'` 收尾（对齐 codex）。task 卡进度流形态待有凭据时补测。
- **虚拟 URL**：`agent://`/`pr://`/`conflict://`/`local://`/`xd://` 会出现在 read/tool 路径 → ChangeTracker.noteEdit 与文件预览需过滤含 `://` 的 location。
- **magic keywords**：`ultrathink`/`orchestrate`/`workflowz` 正文触发。关闭开关待查（config.yml `magicKeywords`？）；第一版走 Composer 输入侧提示，不拦截。

## 8. 结论：ACP 路径可行，无需 rpc-ui 兑底

核心四件套（权限卡 request_permission / 模式 set_mode / 模型 spawn flag+set_config_option / 思考 spawn flag）齐备，
原生 fork/resume 优于 kimi。差异仅在「精细档位靠 spawn flag 而非运行时」，通过每会话独立进程模型天然消化
（此条已被 §9 部分修正：精细档在带模型后也可运行时设置）。

## 9. 二次实测补正（配好凭据后，kimi/minimax/deepseek 自定义 provider）

- **prompt 响应带真实 usage**：`{ stopReason, usage: { inputTokens, outputTokens, totalTokens, cachedReadTokens } }` — OmpAdapter 优先用它（> usage_update 快照 > 估算）。
- **thinking 档动态**：带模型 spawn 后 `set_config_option(thinking, high|max…)` 可用；适配器策略 = 原值直发，被拒降级 auto。
- **`models --json` 实报字段**：`provider / id / selector（即 slug）/ name / contextWindow / maxTokens / reasoning / thinking[] / input[] / cost{input,output,cacheRead,cacheWrite}`；自定义 provider（models.yml）与内置目录自动合并（key 用自定义的、模型元数据补全自内置库）。
- **探针陷阱**：设 `PI_CODING_AGENT_DIR` 指向空目录会把 models.yml/凭据一起隔离 → prompt 秒报 Internal error（无默认模型）。OmpAdapter 不设此变量，无此问题；且 spawn 必须带 `--model`。
- **tool_call 事件实测形态**（write 工具）：`kind='edit'`、`locations=[{path绝对路径}]`、`rawInput={path,content}`、update 带 `content=[{type:'content',content:{type:'text',...}}]` 与 `rawOutput`；status 链 pending→in_progress→completed — 与 KimiAdapter 映射完全兼容。
- **自定义 provider 配置**：`~/.omp/agent/models.yml`（kimi/minimax/deepseek 已由迁移脚本从 opencode.json 同步，三家端到端验证通）。
