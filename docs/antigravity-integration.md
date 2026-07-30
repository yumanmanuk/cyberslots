# Antigravity（agy CLI）集成为 CyberSlots 第五引擎 — 调研与方案

> 状态：**验证阶段完成**，本文供其他 AI 审核。所有结论均为本机实测（Windows 11 22H2，agy CLI v1.1.8）坐实，非文档推断。
> 目标产物：AntigravityAdapter（第五引擎，与 codex/kimi/opencode/omp 并列）+ 界面无感切号 + 不丢上下文。
> 合规红线：流量只走官方 `agy` CLI，不暴露对外端点（非反代）。

---

## 0. 一句话结论

**可行，且无感切号已端到端实测跑通**。agy CLI 提供完整的 headless + stream-json 接口（信封字段与 codex/opencode 同构），认证真源是 **Windows 凭据管理器（keyring）里的明文 JSON blob**，可程序化 `CredWrite` 覆盖实现「无感切号」。

**关键结论（本轮实测修正先前假设）**：agy keyring 凭据用的就是 **antigravity_enterprise client**（`1071006060591-…`，id_token 的 `aud` 铁证），与 cockpit 账号库**同源同 client**。因此 **13 个 cockpit 账号可直接构造 blob 写入 agy keyring**，无需每账号先在 agy 交互登录——先前「双 client、需 gemini-cli 二次登录」的衔接点**已消失**（见 §5/§6.4）。

---

## 1. 需求回顾

- **界面无感切号 + 不丢上下文**：额度快耗尽时，算法推荐轮换账号 → 用户点击切换 → 继续当前任务。服务端新建对话/token/上下文占用都可接受。
- **合规**：流量走官方 agy CLI，无对外端点（反代 = OAuth 接 API 服务器对外暴露端点，会被封；本方案不涉及）。
- **交付**：验证通过 → 出方案文档供其他 AI 审核（即本文）。

---

## 2. headless / stream-json 接口（实测坐实）

### 2.1 关键 flags（v1.1.8 完整 reference，文档 + 实测一致）

| flag | 含义 | 默认 |
|---|---|---|
| `-p` / `--print` / `--prompt` | headless 单轮 | — |
| `--output-format` | `text` / `json` / `stream-json` | `text` |
| `--json-schema` | 约束结构化输出 | — |
| `--model` | 模型 slug（见 §4） | 配置默认 |
| `--effort` | `low`/`medium`/`high`（**仅 claude 等档位独立的模型可用**） | — |
| `--agent` | 指定 agent | — |
| `--continue` / `-c` | 接最近会话 | false |
| `--conversation <ID>` | 接指定 `conversation_id` | — |
| `--dangerously-skip-permissions` | 跳过权限审批 | false |
| `--print-timeout` | headless 超时（如 `90s`） | 5m |
| `--sandbox` | 沙箱执行 | false |

### 2.2 JSON 信封字段（`--output-format json`，实测）

```json
{
  "conversation_id": "uuid",
  "status": "SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING",
  "response": "...",
  "error": "...",
  "duration_seconds": 3.24,
  "num_turns": 1,
  "usage": { "input_tokens":19382, "output_tokens":17, "thinking_tokens":0, "cache_read_tokens":0, "total_tokens":19399 }
}
```

成功退出码 0，失败非 0。未知 model **不静默降级、直接 ERROR**。

### 2.3 stream-json 事件序列（实测）

```
init (1个)  → step_update (N个)  → result (恰好1个)
```

- `init.init` = `{ model, cwd, tools[], permission_mode, agent?, json_schema? }`。本机 `permission_mode: "request-review"`，`tools[]` 含 60+ 内置工具（view_file/replace_file_content/run_command/browser_*/subagent 等）。
- `step_update.step_update` = `{ conversation_id, step_index, state(ACTIVE|DONE), step_type, duration_seconds?, tool_name?, text_delta?, usage?, tool_info?, subagent_info? }`。
  - 实测 `step_type` 出现：`user_input` / `agent_response` / `error_message` / `unknown`（文档另列 `tool` / `checkpoint`）。
  - `tool_info` = `{ name, parameters, output }`，失败带 `error{type,message}`。
  - 子代理步带 `subagent_info` = `{ type_name, role, conversation_id, log_uri, workspace_uris }`。

> **CyberSlots 落地**：EngineAdapter 走 `--output-format stream-json`，把 `step_update` 映射到既有 think/tool/message 流；`result.usage` 喂额度看板。信封与 opencode/codex 高度同构，接入成本低。

---

## 3. 认证与「无感切号」机制（本次核心实测）

### 3.1 认证真源 = Windows 凭据管理器（keyring），不是文件

**实测判定**：把 `~/.gemini/oauth_creds.json` rename 成 `.disabled` 后，`agy -p ... --model claude-sonnet-4-6` 仍 `status:SUCCESS` 返回结果，且 agy **没有重建该文件**。

→ 结论：**agy headless 认证读取 keyring 条目 `gemini:antigravity`，`oauth_creds.json` 文件不是必需的**。凭据管理器条目：

```
Target : LegacyGeneric:target=gemini:antigravity
User   : antigravity
```

### 3.2 keyring blob 结构 = 明文 UTF-8 JSON（可程序化覆盖）

CredRead 读出的 blob 是 **1440 字节、100% 可打印的明文 JSON**（注意：Windows blob 常被误当 UTF-16，本例实为 UTF-8）：

```json
{
  "token": {
    "access_token": "ya29....",        // len≈261
    "token_type": "Bearer",
    "refresh_token": "1//06....",       // len≈103
    "expiry": "2026-07-...T..."          // ISO8601, len≈33
  },
  "id_token": "eyJhbGci....",            // JWT, len≈922
  "auth_method": "consumer"              // 个人账号
}
```

→ **换号 = 用 `CredWrite` 覆盖 `gemini:antigravity` 这条 blob 为目标账号的同结构 JSON**。这是「无感切号」的技术地基，已完全坐实可行（§3.6 端到端实测）。

> **`auth_method:"consumer"` 不代表用 gemini-cli client**：blob 里的 `id_token` 解码 `aud=1071006060591-…`（antigravity_enterprise），refresh_token 与 cockpit 同账号逐字节相同。`consumer` 只是个人账号标识，不是 OAuth client 归属。先前误判见 §5 修正。

### 3.3 多账号索引已原生存在

`~/.gemini/google_accounts.json`：

```json
{ "active": "enzoharris7777@gmail.com", "old": ["huntinggeter@gmail.com","yumanmanuk@gmail.com"] }
```

agy 自身就有 active/old 多账号概念。切号时同步更新此文件的 `active`，与 keyring 覆盖保持一致。

### 3.4 换号落地步骤（建议实现）

1. CyberSlots 维护账号池（每账号一份 keyring blob 结构，字段见 §3.2）。
2. 切号时：`CredWrite('gemini:antigravity', 目标账号 blob)` + 更新 `google_accounts.json.active`。目标账号 blob **可直接从 cockpit `accounts/{id}.json` 构造**（`token.{access_token,refresh_token,id_token}` + `token_type:"Bearer"` + `expiry`(把 cockpit 的 `expiry_timestamp` 转 ISO8601) + `auth_method:"consumer"`）。
3. access_token 过期由 agy 用 blob 里的 refresh_token 自动刷新；切号时也可主动用 **enterprise client** 现刷一次拿新鲜 token 再写（切号更稳，见 §3.6）。
4. 续接上下文：切号后用 `--conversation <上次 conversation_id>` 接回当前任务。**实测坐实跨账号可续接且上下文完整保留**（单机，机制见 §3.8）。

### 3.5 会话续接机制（`/resume`，官方文档坐实）

切号后「不丢上下文」靠 agy 自带的会话续接，有两条可靠路径：

- **显式指定（推荐，最可控）**：`agy --conversation <conversation-id>`。CyberSlots 自己从 stream-json 的 `init.conversation_id` / `result.conversation_id` 拿到 id 存着，切号后显式传回。
- **自动接最近**：`agy -c` / `--continue`，由工作区路径解析。

> **关键：`-c` 的解析依赖本地缓存**：`~/.gemini/antigravity-cli/cache/last_conversations.json`，结构是 `{ "<绝对工作区路径>": "<conversation-id>" }`。`agy -c` = 查此表→后端校验会话存否→加载（不存则新开）。
>
> **切号影响评估（已实测修正）**：`last_conversations.json` 按工作区路径索引、**不区分账号**，故 `-c` 跨账号不可靠，CyberSlots 应自建「任务↔conversation_id」映射、切号后显式 `--conversation` 回传。——但早前本节断言“新账号后端可能无此会话→校验失败→新开”**已被实测证伪**：跨账号显式 `--conversation` 实测 **SUCCESS 且上下文完整保留**（机制是 agy 把对话历史存本地、跨账号共享，详见 §3.8）。
> `/resume` 还支持从 Antigravity 2.0 桌面端导入会话（仅交互态）。

### 3.6 端到端切号实测（本轮坐实，形成完整闭环）

三段验证 + 一段反证，证明 **CyberSlots 直接 `CredWrite` keyring 即可程序化换号，agy 每次调用实时读 keyring 认证**：

| 步骤 | 操作 | 结果 |
|---|---|---|
| 备份 | CredRead 备份原始 blob（enzoharris7777, 1440B）+ `google_accounts.json` | ✅ |
| 切号 A | 读 cockpit 账号 `1c6ot785@gmail.com` → enterprise client 现刷（200）→ 构造 blob → CredWrite | `agy -p` → **SUCCESS**（19396 tok） |
| 切号 B | 换 `svenbaron24@gmail.com` 重复上步 | `agy -p` → **SUCCESS**（19404 tok），证明可重复非缓存 |
| 反证 | 写入损坏 access_token/refresh_token 到 keyring | `agy -p` → **ERROR 401 UNAUTHENTICATED**，0 tok（证明 agy 实时读 keyring、无本地会话缓存兜底） |
| 还原 | CredWrite 写回备份 blob + 还原 `google_accounts.json` | `agy -p` → **SUCCESS**，恢复为 enzoharris7777 |

> **关键推翻**：切号 A/B 用的是 cockpit 的 **enterprise refresh_token**，直接写进 keyring 后 agy 正常认证并出结果——坐实 **agy keyring 与 cockpit 用同一 enterprise client**，先前「agy 用 gemini-cli client、cockpit 凭据不能直接喂 agy」的判断错误。
>
> **脚本留档**（`.dev/workdir/`，含明文凭据，仅本地）：`keyring-backup.ps1`（CredRead 备份）/ `build-switch-blob.mjs`（读 cockpit 账号 + enterprise 现刷 + 生成 blob）/ `keyring-write.ps1`（CredWrite 覆写 + 同步 google_accounts）/ `keyring-restore.ps1`（还原）。

### 3.7 CLI 与 IDE 认证存储分离（实测坐实，切号互不干扰）

**结论：agy CLI 与 Antigravity IDE 的认证真源是两个独立存储，CyberSlots 的 keyring 切号完全不碰 IDE，两者可并行不同账号。**

| | agy CLI（本方案） | Antigravity IDE（cockpit 切号对象） |
|---|---|---|
| 认证真源 | keyring 条目 `gemini:antigravity`（+ `~/.gemini/google_accounts.json` 的 active 指针） | IDE 的 VS Code globalStorage SQLite：`%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` |
| 生效方式 | agy 每次调用实时读 keyring，覆写即生效 | IDE 仅启动时读一次并缓存内存 |
| 切号是否需重启 | 否 | **是**（必须杀进程 + 重启） |

**cockpit 切 IDE 账号流程（日志逐行坐实）**：更新「IDE 默认实例绑定账号」→ `taskkill` 强杀运行中的 IDE 进程 → 把 token 注入 `state.vscdb`（日志原文「注入 Token 到数据库 ... state.vscdb」「Token 注入成功」）→ 重启 IDE。

**证据**：
- Windows 凭据管理器全量枚举只有一条 `gemini:antigravity`，无 IDE 专属条目；
- `state.vscdb` 二进制串含 `access_token`/`oauth`/`gemini` 及多账号邮箱，坐实 IDE 认证材料存此处；
- 实测时 `google_accounts.json` active（enzoharris7777，被我们 keyring 切号改写）与 cockpit `current_account.json`（1c6ot785，IDE 侧）不一致——证明两条线独立。

**对集成的意义**：CyberSlots 只覆写 CLI 的 keyring，不动 IDE/cockpit 的 `state.vscdb`；可 IDE 挂 A 账号、CyberSlots 的 agy 同时跑 B 账号并行；且无需模仿 cockpit 的「杀进程+重启」重流程，切号无感、秒级。

### 3.8 本轮补充实测：跨账号续接 + 实时读 keyring（回应评审致命①②）

> 原始留档：`.dev/workdir/exp-crossaccount-evidence.md`。针对 `antigravity-integration-review.md` 的两条致命补齐实测。

**(a) 跨账号“不丢上下文”——单机成立（推翻 §3.5 早前悲观判断）**：账号 A 建会话记密语 `ZEBRA-92137`（CID_A）→ 切到账号 B → `agy --conversation CID_A` 问密语 → **SUCCESS、同 CID_A、num_turns=3、答出 ZEBRA-92137**。
- 机制：agy 把对话历史存**本地 SQLite** `~/.gemini/antigravity-cli/conversations/<cid>.db`（**按 CLI 安装存储、不按账号**），续接时从本地重放整段历史发给当前账号。
- ✅ 单机可靠（CyberSlots 用例满足）；⚠️ 本地态：不跨机器、清缓存即失效；⚠️ 成本：跨账号续接会把整段历史 token 重新计入**新账号**（实测 input_tokens 由 ~19k 涨到 40k），长对话轮换的额度成本需计入调度。

**(b) 实时读 keyring / 无缓存——已补 401 留档**：写入结构合法但功能失效的凭据 → call#1(~0s)/call#2(5s) 均 **ERROR 401 UNAUTHENTICATED、0 token**；写回好凭据立即 SUCCESS。证明 agy **每次调用实时读 keyring、无跨调用缓存兑底**。
- 诚实边界：验证的是**调用间**实时读（= CyberSlots 切号用例，切号在任务/轮次之间），未验证单个长 stream **流内中途**改 keyring（非本方案用例）。

### 3.9 自动刷新 / refresh_token 稳定 / 并发模型（回应评审工程致命项）

> 原始留档：`.dev/workdir/exp-crossaccount-evidence.md` 实验四/六/五。

| 发现 | 实测 | 对集成的含义 |
|---|---|---|
| **agy 自动刷新** | 写【失效 access_token + 有效 refresh_token + 过期 expiry】→ agy SUCCESS | 切号只需写对 **refresh_token**，access_token 可旧；agy 自刷 |
| **agy 回写 keyring** | 自刷后回读：access_token 变新、expiry 变未来、**refresh_token 不变** | keyring 会被 agy 原地更新；CyberSlots 缓存的 blob 快照可能被覆盖（但 refresh_token 稳定无影响） |
| **refresh_token 不轮换** | 同一 enterprise refresh_token 连刷 4+ 次均 200 | 评审致命 #6（三方持同一 rt、一方刷作废其他方）**不成立**；各方各刷各的 access_token |
| **在途进程免疫** | agy#1 运行中中途损坏 keyring，agy#1 仍 SUCCESS；agy#2（新进程）401 | 每个 agy **启动时**绑定账号，中途切号不伤在途任务（修正评审 #5“半身换身份”） |

**并发约束（保留）**：keyring 是全局单槽，多个并发任务要跑不同账号时，必须串行化“写 keyring → 拉起 agy（确保进程启动完成、读完 keyring）→ 才能下一次切号”这个临界区（应用层互斥锁）。一旦 agy 启动完成，它已免疫后续切号。

---

## 4. 模型目录（`agy models` + 实测）

| slug | 说明 | 实测 |
|---|---|---|
| `claude-sonnet-4-6` | Claude Sonnet 4.6 Thinking | ✅ 跑通，PONG，19399 tok |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 Thinking | 未单测 |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro | 未单测 |
| `gemini-3.6-flash-high/medium` | Gemini flash（**档位已含在 slug**） | — |
| `gemini-3.5-flash-medium` | Gemini flash | ⚠️ 单独调用返回 ERROR（见坑①） |

**坑①**：gemini flash slug **已含档位**，再加 `--effort` 会报 `invalid model selection: ... conflicts with --effort`（且此校验在认证前，会掩盖认证测试）。claude 档位独立，可配 `--effort`。

**坑②**：`gemini-3.5-flash-medium` 即使不带 `--effort`，headless 单轮也稳定返回 `status:ERROR`（`error_message` step，无细节）；`claude-sonnet-4-6` 同条件稳定 SUCCESS。→ **默认引擎模型建议用 claude-sonnet-4-6**，gemini flash 的可用性待进一步确认。

---

## 5. OAuth client 归属（本轮实测推翻先前假设）

先前版本断言「agy 用 gemini-cli 公共 client，cockpit 用 enterprise client，两者隔离」——**这个结论错误**，源于把已陈旧的 `oauth_creds.json`（停在 5/20）当成了 agy 的活凭据。

**实测修正（id_token `aud`/`azp` 铁证 + §3.6 端到端切号）**：

| 用途 | client_id | 实测判定 |
|---|---|---|
| **agy keyring（真正在用）** | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep` | keyring blob 的 id_token `aud=1071006060591`，**即 antigravity_enterprise**；refresh_token 与 cockpit 同账号逐字节相同 |
| cockpit-tools | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep` | 同上，**与 agy keyring 同一 client** |
| ~~gemini-cli 公共~~ | `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j` | 仅陈旧 `oauth_creds.json` 里的历史凭据，**当前 headless agy 不用它**（禁用该文件后 agy 仍 SUCCESS） |

**影响（正向）**：cockpit 账号库里的 refresh_token（enterprise client）**可直接写入 agy keyring**，无需每账号先在 agy 登录。CyberSlots 账号池直接复用 cockpit 账号库即可。

- 实测（本轮已留档，三重坐实）：
  1. **id_token aud**：keyring blob 的 id_token `aud=1071006060591`（enterprise），可随时复算；
  2. **刷新矩阵**：enterprise refresh_token（=keyring）用 gemini-cli client 刷 → **401 unauthorized_client**；反之 gemini-cli refresh_token 用 enterprise client 刷也 401；同源均 200（`exp-crossclient.mjs`）；
  3. **跨 client 注入**：把真实有效的 gemini-cli 凭据（aud=681…）写入 keyring → `agy -p` → **ERROR Eligibility check failed: PERMISSION_DENIED (403)**——agy 后端**强制要 enterprise client**，非此 client 的有效令牌也拒。
- Google OAuth refresh_token 严格绑定签发 client，用错 client 刷报 401。

---

## 6. 额度查询 — 走 cockpit 链路（已定，非 agy 端点）

**结论**：额度查询走 cockpit 那套账号库 + enterprise client，能在**不登录 agy、零消耗**的前提下**一次查完所有账号**。（注：下表 403 是早期用陈旧 gemini-cli token 测的；既然 agy keyring 实为 enterprise token，额度端点对 agy 当前 token 应也可用，但额度调度仍建议走 cockpit 库以便一次性扫全账号、不干扰 agy 当前会话。）

### 6.1 为什么不走 agy 端点（实测）

| 端点 | agy 的 gemini-cli token | cockpit 的 enterprise token |
|---|---|---|
| `v1internal:loadCodeAssist` | ✅ 200 → project_id / tier | ✅ |
| `v1internal:fetchAvailableModels` | ❌ **403 PERMISSION_DENIED** | ✅ |
| `v1internal:retrieveUserQuotaSummary` | ❌ **403 PERMISSION_DENIED** | ✅ |

> UA/payload 已按 cockpit 对齐（`antigravity/{ver} {os}/{arch}`、body `{project}`），排除请求格式问题——确系**额度端点权限绑 enterprise client**。

### 6.2 cockpit 账号库（实测坐实，`~/.antigravity_cockpit/`）

- `credentials.json`：按 email 存各账号 `{email, accessToken, refreshToken, expiresAt, projectId}`（**enterprise client 的 refresh_token**）。本机实测 **13 个账号**。
- `accounts.json`：账号元数据 `{version, accounts:[{id,email,name,created_at,last_used}], current_account_id}`。
- `current_account.json`：`{email, updated_at}` 当前活跃账号。
- `cache/quota_history/`：**每账号一份额度历史快照**（按时间戳），可直接读做趋势/建模。

### 6.3 查额度链路（复刻 cockpit）

对账号池每个账号：用 **enterprise client**（`1071006060591-…`）现刷 `refreshToken` → `access_token` → 先 `loadCodeAssist` 取 `project_id` → POST `cloudcode-pa.googleapis.com`（或 `daily-`）`/v1internal:retrieveUserQuotaSummary`，body `{project}`，UA=`antigravity/{ver} {os}/{arch}`，Accept-Encoding gzip → 返回 weekly + 5h bucket（剩余百分比 + reset 时间）。

> **架构要点（额度与推理同源）**：额度调度走 cockpit 账号库 + enterprise client（只读、全账号、零消耗）；推理执行走 agy + keyring（**同为 enterprise client**）。两者同源，同一账号的 refresh_token 可互通（cockpit 凭据可直写 keyring，见 §3.6）。

### 6.4 衔接点：已打通（本轮推翻先前的“待确认”） ✅

先前担心「cockpit 存 enterprise 凭据、agy 要 gemini-cli 凭据，两套需分别登录」——**实测证伪**。agy keyring 本身就是 enterprise 凭据（id_token aud 铁证），与 cockpit 同账号逐字节相同。§3.6 端到端实测：把 cockpit 账号的 enterprise refresh_token 直接写 keyring，agy 正常认证并出结果。

→ **13 个 cockpit 账号均可直接构造 blob 写入 agy keyring**，无需任何额外登录。衔接点消失，切号链路完整贯通。

---

## 7. 执行模式与权限模型（官方文档 + 实测）

> **两个正交维度（Best Practices 页坐实，勿混为一谈）**：
> - **执行模式** `agentMode`：`default` / `accept-edits` / `plan`——管**文件编辑**是否自动批准。
> - **工具权限** `toolPermission`：`request-review`（默认）/ `proceed-in-sandbox` / `always-proceed`（从不提示）/ `strict`（所有非只读工具都提示）——管写/bash/网络**审批级别**（据 Reference 页 settings.json 完整表，实为 4 档）；配套 `enableTerminalSandbox`。另有独立的 `artifactReviewPolicy`（`asks-for-review`/`agent-decides`/`always-proceed`）专管写代码审阅。
>
> 二者是 `settings.json` 里的不同字段。stream-json `init.permission_mode` 报的 `request-review` 是 **`toolPermission`** 的值，不是执行模式。`default` 执行模式在行为上表现为 request-review 审批，故下表用括号标注对应关系，但字段本身独立。headless 全自动应**同时**设 `agentMode=accept-edits`（文件）+ `toolPermission=always-proceed`（彻底免 shell/网络 提示），或保守地用 `proceed-in-sandbox` + `enableTerminalSandbox`。

### 7.1 三种执行模式（`--mode` / `agentMode`）

| 模式 | 行为 | headless 含义 |
|---|---|---|
| `default`（=request-review） | 改文件/建文件前暂停，渲染 diff 等审批 | 实测 `init.permission_mode` 就是它；headless 下需审批的写操作会**软拒绝** |
| `accept-edits` | 自动批准所有文件写/建/改（`write_to_file`/`replace_file_content`/`multi_replace_file_content`），**子代理也继承** | **赛马全自动应用此模式** |
| `plan` | 自动前置 `/plan`，先用只读工具调研再出结构化方案 | 探索阶段可用 |

启动：`agy --mode=accept-edits`（或 `--mode=plan`）。注意是 `--mode`，**不是 `--permission-mode`**（后者会报错）。交互态可 `Shift+Tab` 循环 `default → accept-edits → plan`。

持久化：`~/.gemini/antigravity-cli/settings.json` 里 `{ "agentMode": "accept-edits" }`（与 `/settings` 面板的 Agent Mode 同步）。

### 7.2 权限（独立于执行模式，管 shell 命令）

- 执行模式管**文件操作**；`run_command`（shell）另由 `/permissions` 规则或 `--dangerously-skip-permissions` 控制，**跨所有模式生效**。
- headless 默认 `request-review`：需审批工具**软拒绝**（继续跑、退出 0、stderr 提示），不挂起。
- 规则格式 `action(target)`（如 `command(git)` / `command(git diff)` / `write_file(src/)`），分 allow/deny/ask 三表；三个 scope：**Project**（仅当前项目）/ **Shared**（跨 Antigravity 产品共享）/ **Global**（所有会话）。可 `/permissions` 交互维护，也可写 settings 文件。
- 全自动场景：`--mode=accept-edits`（文件）+ `--dangerously-skip-permissions`（shell，谨慎，建议配 sandbox）；或更稳健地预写 Project scope 白名单（如 `command(git)`/`command(npm)`）避免全开。

### 7.3 Sandbox（OS 原生隔离，与模式正交）

- Windows 用 **AppContainer**（macOS `sandbox-exec` / Linux `nsjail`）隔离文件系统/注册表可见性，零执行开销。
- `sandbox` **不是执行模式**（不在 Shift+Tab 循环里），是 OS 容限设置，`--sandbox` 开启。全自动跑 + skip-permissions 时建议套 sandbox 兑底。

### 7.4 后台子代理 / 任务（仅交互态，供参考）

交互态有 `/agents`（子代理面板：id/role/state/step）、`/tasks`（非 agentic 后台进程）、自定义 agent（`.agents/agents/<name>.md` 或 `~/.gemini/config/agents/`，YAML frontmatter 含 `subagent:true` 可被 `invoke_subagent`）。stream-json 的 `subagent_info` 对应这些——CyberSlots 渲染子代理步时可用。

---

## 8. 建议实现清单（CyberSlots 侧）

1. `src/main/engine/antigravity/resolveAntigravity.ts`：定位 `%LOCALAPPDATA%\agy\bin\agy.exe`（agy 升级不自动进 PATH，已手动写入用户 PATH；代码侧仍建议显式绝对路径兑底）。
2. `src/main/engine/antigravity/AntigravityAdapter.ts`：`--output-format stream-json` 驱动，映射 `init/step_update/result` 到既有事件流；`--continue`/`--conversation` 支持续接；赛马全自动跑用 `--mode=accept-edits`（需时配 `--dangerously-skip-permissions` + `--sandbox`）。
3. **推理切号**（agy 侧）：`CredWrite('gemini:antigravity', blob)` + 同步 `google_accounts.json.active`；blob 结构见 §3.2。
4. **额度调度**（cockpit 侧，与推理解耦）：读 `~/.antigravity_cockpit/credentials.json` 账号库，用 enterprise client 现刷 token 批量查 `retrieveUserQuotaSummary`（§6.3）；可直接复用 `cache/quota_history/` 历史。
5. 默认模型 `claude-sonnet-4-6`；gemini flash 待可用性确认后开放。
6. 遵守 `.qoder/rules/brand-loading.md`：所有 loading 用 BrandSpinner/BrandHero。

---

## 9. 验证脚本 / 证据留档

- `scripts/probe-agy-quota.mjs`：双 client 刷新 + loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary（只读，实测 §5/§6）。
- `.dev/workdir/test-cred-source.ps1`：keyring vs 文件判定（实测 §3.1）。
- `.dev/workdir/read-keyring.ps1` / `dump-keyring-hex.ps1` / `dump-keyring-struct.ps1` / `inspect-keyring.ps1`：keyring blob 结构提取（实测 §3.2；`inspect-keyring.ps1` 为 UTF8 正确解码版）。
- `.dev/workdir/keyring-backup.ps1` / `build-switch-blob.mjs` / `keyring-write.ps1`（含 precheck 校验）/ `keyring-restore.ps1`：端到端切号实测链路（实测 §3.6）。
- `.dev/workdir/exp-crossclient.mjs` / `build-geminicli-blob.mjs`：跨 client 归属实验（实测 §5）。
- `.dev/workdir/exp-crossaccount-evidence.md`：跨账号续接/实时读/自刷/rotation/并发/指纹的原始留档（实测 §3.8/§3.9）。
- **机密外置**：OAuth client secret 已从以上脚本硬编码中移除，统一由 `scripts/agyClients.mjs`（无密、可提交）从环境变量或 gitignored `.dev/agy-clients.json` 加载。

---

## 10. 待审核 / 待决策点

1. ~~衔接点（§6.4）：agy 推理需 gemini-cli client blob……每账号是否必须先在 agy 交互登录？~~ ✅ **已解决**：agy keyring 就是 enterprise 凭据，13 个 cockpit 账号可直接写 keyring（§3.6/§5/§6.4）。
2. 账号池凭据存储安全性（CyberSlots 侧加密 vs 直接依赖 OS keyring / 复用 cockpit 账号库）？
3. gemini flash 系列不可用是环境问题还是 tier 限制，是否需要开放？
4. 切号后续接策略：**已定为显式 `--conversation <id>`**（§3.5）——`-c` 依赖的官方 `last_conversations.json` 不区分账号，跨账号不可靠；CyberSlots 自建任务↔conversation_id 映射。

---

## 11. 谷歌滥用识别 / 封号风险评估

> 结论先行：**「切号方式」本身（写 keyring、走官方 agy CLI）不新增伪造/破解类高危信号，比反代/伪造 API 隐蔽且合规得多；但「一人多号、同机轮换榚取免费额度」这一前提本身是 TOS/策略层的滥用，该风险与切号技术无关、无法用技术手段消除。CyberSlots 只是复用既有 cockpit 账号池，不放大也不缩小这个底层风险。**

### 11.1 风险分层

| 层级 | 风险点 | 我方方案的影响 |
|---|---|---|
| **传输/协议层** | 伪造 API、非官方 UA、反代 | ✅ **无此风险**：流量 100% 走官方 agy CLI，UA/协议/client 均官方 |
| **凭据层** | 盗用/破解 token、伪造凭据 | ✅ **无此风险**：用的是账号本人 OAuth 登录拿到的真实 refresh_token，仅搬运位置 |
| **账号归属层** | 一人多号、同设备/同 IP 关联 | ⚠️ **根本风险**：13 号同机同 enterprise client，设备指纹/IP 可关联为“一人多号” |
| **行为层** | 规律化批量操作、榚干每号额度 | ⚠️ **中等**：程序化轮换 + 错峰预热 + 额度最大化消耗，是典型养号特征 |

### 11.2 为什么“切号方式”这一环风险低
1. **走官方 CLI**：Google 后端看到的是“该账号在用官方 agy”，请求路径/UA/client 合规，无伪造痕迹。
2. **只搬运真实凭据**：keyring 里的 refresh_token 是账号自己登录签发的，非盗非破。
3. **单账号串行**：任一时刻 keyring 只有一个账号，agy 单账号顺序使用，表面上就是“一个用户用一个号”。
4. **不碰 IDE/cockpit**：不引入额外的进程杀重启等异常动作（见 §3.7），行为异常度低于 cockpit 现状。

### 11.3 不可消除的根本风险
- **前提即违规**：若 Google TOS 禁止一人操作多号倍增免费额度（几乎必然禁止），那么“13 号轮换”从策略层就是滥用，无论切号多干净都不改变这一点。
- **关联向量**：设备指纹、IP、账号注册/验证信息（手机号/支付）重叠、行为时序——这些是 Google 识别“多号归一人”的主要手段，均在切号技术之外。
- cockpit 已内置 `fingerprints.json`（设备指纹管理）说明这类工具早已意识到指纹关联是主要风险并试图规避——反过来也印证该风险真实存在。
- ⚠️ **实测新增向量（agy 共享 installation_id）**：agy 本地有稳定的 `installation_id`/`installation_uuid`（`~/.gemini/antigravity-cli/installation_id` 等），**按安装存储、切号时不变** → 同一 agy 跑的 13 号共享一个 installation_id。若 agy 向后端上报它（需抓包确认），则是一条 CyberSlots **无法消除**的强关联信号（不像 cockpit 能给每号配独立 machine_id；走官方 CLI 反而失去了这层隔离）。

### 11.4 降低风险的建议（若继续推进）
1. **留额度 buffer**：不要把每号周额度榚到极限，接近上限的“贴脸消耗”最像滥用。
2. **弱化规律性**：错峰预热虽利于额度对齐，但“每周同一时刻批量唤醒全部账号”规律性极强，建议加抖动。
3. **任务内单账号连续**：同一任务尽量用同一账号跑完，减少任务中途切号的高频轮换。
4. **额度查询走缓存**：`retrieveUserQuotaSummary` 复用 cockpit `cache/quota_history/`，避免高频探测。
5. **指纹/IP 一致性**：CyberSlots 若不接管指纹，则沿用 cockpit 环境；切勿在切号同时变更 IP/指纹（前后不一致反而更可疑）。

### 11.5 定位
CyberSlots 的 agy 集成在**技术合规性上优于反代方案**（真实凭据 + 官方 CLI），但**不能声称“无封号风险”**：底层是既有账号池的 TOS 风险，属用户已自行承担的存量风险。集成层应把“降低行为异常度”作为设计目标（低频轮换、留 buffer、弱规律化），而非追求“额度利用率最大化”。
