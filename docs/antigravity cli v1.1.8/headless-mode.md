# Headless 模式（Headless mode）

> 非交互式运行 Antigravity CLI，用于脚本化 agent 任务、接入 CI 流水线、捕获机器可读输出。

Headless 模式（也叫 **print mode**）向 agent 发送单条 prompt，流式或一次性返回响应，然后退出。任何需要把 agent 输出喂给程序（而非终端 UI）的场景都用它。

## 运行单条 prompt

用 `-p`（别名 `--print`、`--prompt`）传一条 prompt，跑一次即退出：

```bash
agy -p "In one sentence, what is a git rebase?"
```
```
A git rebase rewrites the commit history by transplanting a sequence of commits onto a new base commit, imposing a strictly linear progression of changes that eliminates arbitrary merge artifacts.
```

响应走 **stdout**；诊断信息——错误、认证提示、进度、权限通知——走 **stderr**。这种分流让捕获到的响应保持干净：

```bash
# 只捕获模型响应；诊断仍打印到终端。
answer=$(agy -p "Name three popular version control systems, comma-separated.")
```

> **注意**：Headless 模式使用你的**缓存凭据**。请先用一次交互式 `agy` 会话完成认证。在没有终端的非交互环境（如 CI）里，一个尚未认证的运行会**以"authentication required"错误退出**，而不是挂起。

## 输出格式

`--output-format` flag 控制 stdout 的形态，接受三个值：

| 格式 | stdout 形态 | 用途 |
|---|---|---|
| `text` | 响应文本（默认） | 人类可读输出、快速脚本 |
| `json` | 运行完成时打印一个 JSON 对象 | 捕获结果 + 元数据 |
| `stream-json` | 换行分隔的 JSON（NDJSON）事件 | 监控进度、工具、token 用量 |

### text（文本）

默认。响应文本直接进 stdout，无任何包裹：

```bash
agy -p "In one sentence, what does the command git bisect do?"
```
```
Git bisect executes a binary search algorithm across a project's commit history to rapidly isolate the precise commit responsible for introducing a defect.
```

### json

设 `--output-format json` 在运行完成后得到单个 JSON 信封。CLI 把它打在一行；管道给 `jq` 美化：

```bash
agy -p "In one sentence, what is a git rebase?" --output-format json | jq
```
```json
{
  "conversation_id": "055a398f-db14-4c5f-abbb-1bf03f8120a7",
  "status": "SUCCESS",
  "response": "A git rebase rewrites the commit history by transplanting a sequence of commits onto a new base commit, imposing a strictly linear progression of changes that eliminates arbitrary merge artifacts.\n",
  "duration_seconds": 7.16,
  "num_turns": 1,
  "usage": {
    "input_tokens": 10415,
    "output_tokens": 657,
    "thinking_tokens": 616,
    "cache_read_tokens": 8113,
    "total_tokens": 11072
  }
}
```

信封字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `conversation_id` | string | 对话 ID，供之后续接 |
| `status` | string | 终态状态（见「状态值」） |
| `response` | string | agent 的自由文本响应 |
| `error` | string | 错误信息；仅失败时出现 |
| `duration_seconds` | number | 运行的挂钟耗时 |
| `num_turns` | number | 对话里的用户回合数 |
| `structured_output` | object | 解析后的 schema 输出；仅带 `--json-schema` 时出现 |
| `json_schema` | object | 被强制的 schema；仅带 `--json-schema` 时出现 |
| `usage` | object | token 计数：`input_tokens`、`output_tokens`、`thinking_tokens`、`cache_read_tokens`、`total_tokens` |

#### 用 schema 约束结构化输出

传 `--json-schema` 把答案约束到某个 schema。解析后的对象出现在 `structured_output`，而 `response` 持有同一 payload 的字符串序列化形式：

```bash
agy -p "Parse the semantic version string v2.14.3 into an object with integer fields major, minor, and patch." \
  --output-format json \
  --json-schema '{"type":"object","properties":{"major":{"type":"integer"},"minor":{"type":"integer"},"patch":{"type":"integer"}},"required":["major","minor","patch"]}' | jq
```
```json
{
  "conversation_id": "4e502687-290c-4030-b908-5ed6c68fa5dc",
  "status": "SUCCESS",
  "response": "{\"major\":2,\"minor\":14,\"patch\":3}\n",
  "duration_seconds": 4.45,
  "num_turns": 1,
  "structured_output": {
    "major": 2,
    "minor": 14,
    "patch": 3
  },
  "json_schema": {
    "type": "object",
    "properties": {
      "major": { "type": "integer" },
      "minor": { "type": "integer" },
      "patch": { "type": "integer" }
    },
    "required": ["major", "minor", "patch"]
  },
  "usage": {
    "input_tokens": 10522,
    "output_tokens": 354,
    "thinking_tokens": 329,
    "cache_read_tokens": 8112,
    "total_tokens": 10876
  }
}
```

该 flag 接受 **schema 字符串**、`.json` schema 文件路径，或一个**原始类型名**（`string`、`number`、`integer`、`boolean`）。从 `structured_output` 读解析后的值：

```bash
agy -p "Parse the semantic version string v2.14.3 into an object with integer fields major, minor, and patch." \
  --output-format json \
  --json-schema '{"type":"object","properties":{"major":{"type":"integer"},"minor":{"type":"integer"},"patch":{"type":"integer"}},"required":["major","minor","patch"]}' \
  | jq '.structured_output'
```

### stream-json（流式 JSON）

设 `--output-format stream-json`，随运行进展每行输出一个 JSON 对象（NDJSON）。用这个格式实时观察工具调用和 token 用量。

```bash
agy -p "In one sentence, what is a git rebase?" --output-format stream-json
```

流以**一个 `init` 事件**开头，跟着**任意数量的 `step_update` 事件**，以**恰好一个 `result` 事件**结尾（下面 `cwd` 和 `tools` 数组做了缩略）：

```json
{"event":"init","conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","init":{"cwd":"/home/user/project","tools":["ask_permission","run_command","write_to_file","..."],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"Git rebase destructively rewrites a branch's commit history by systematically detaching its unique commits and sequentially reapplying them onto a new base commit.\n","duration_seconds":6.28,"usage":{"input_tokens":10302,"output_tokens":582,"thinking_tokens":551,"cache_read_tokens":8113,"total_tokens":10884}}}
{"event":"step_update","step_update":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.53,"usage":{"input_tokens":116,"output_tokens":7,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":123}}}
{"event":"result","result":{"conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","status":"SUCCESS","response":"Git rebase destructively rewrites a branch's commit history by systematically detaching its unique commits and sequentially reapplying them onto a new base commit.\n","duration_seconds":6.88,"num_turns":1,"usage":{"input_tokens":10418,"output_tokens":589,"thinking_tokens":551,"cache_read_tokens":8113,"total_tokens":11007}}}
```

当响应分块流入时，`agent_response` 步会在最终 `DONE` 之前发出一个或多个 `ACTIVE` 事件，携带部分 `text_delta` 片段；像这样的短响应则在单个 `DONE` 里一次到达。

每一行都是一个事件对象，其 `event` 字段标明类型：

| event | payload 键 | 发出时机 |
|---|---|---|
| `init` | `init` | 一次，流开始时 |
| `step_update` | `step_update` | 每次步转换或文本增量 |
| `result` | `result` | 一次，末尾（形态与 `json` 相同） |

`init` payload 记录运行配置。`model` 和 `agent` 仅在用 `--model` / `--agent` 设置时出现；`permission_mode` 默认为 `request-review`（在 `--dangerously-skip-permissions` 下则为 `always-proceed`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `cwd` | string | 工作目录 |
| `tools` | string[] | 所有可用工具的名称 |
| `permission_mode` | string | 生效的权限模式 |
| `model` | string | 使用中的模型，被覆盖时 |
| `agent` | string | 活动 agent，被覆盖时 |
| `json_schema` | object | 被强制的 schema，用 `--json-schema` 设置时 |

每个 `step_update` payload 描述一个步。观测到的 `step_type` 值包括 `user_input`、`agent_response`、`tool`、`checkpoint`；`state` 在步运行中为 `ACTIVE`、完成时为 `DONE`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `conversation_id` | string | 对话 ID |
| `step_index` | number | 从 0 开始的步索引 |
| `state` | string | `ACTIVE` 或 `DONE` |
| `step_type` | string | 步类别，例如 `agent_response` 或 `tool` |
| `tool_name` | string | 规范工具名，在 tool 步上 |
| `text_delta` | string | 增量响应文本 |
| `duration_seconds` | number | 步耗时，已知时 |
| `usage` | object | 每步 token 用量，已知时 |
| `tool_info` | object | 工具调用详情（见下） |
| `subagent_info` | object | 子代理调用详情 |

#### 流中的工具调用

在 tool 步上，`tool_info` 携带调用及其结果。这是一个真实的 tool 步，来自执行 `echo hello_headless_demo` 的运行：

```json
{
  "event": "step_update",
  "step_update": {
    "conversation_id": "edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3",
    "step_index": 4,
    "state": "DONE",
    "step_type": "tool",
    "tool_name": "run_command",
    "duration_seconds": 0.07,
    "tool_info": {
      "name": "run_command",
      "parameters": {
        "CommandLine": "echo hello_headless_demo"
      },
      "output": "hello_headless_demo\r\n"
    }
  }
}
```

`tool_info` 持有 `name`、`parameters`、`output`，以及——当工具失败时——一个带 `type` 和 `message` 的 `error` 对象。派生子代理的步改为携带 `subagent_info`，在 `subagents` 下列出每个子代理（含 `type_name`、`role`、`conversation_id`、`log_uri`、`workspace_uris`）。

#### 流中的结构化输出

带 `--json-schema` 时，schema 应用于终态的 `result` 事件，它携带与 `json` 信封相同的 `structured_output` 和 `json_schema` 字段。

## 用 jq 解析输出

stdout 是机器可读的，所以 `jq` 能精确抽取你要的东西。

从 JSON 运行里取响应文本：

```bash
agy -p "Name three popular version control systems, comma-separated." --output-format json | jq -r '.response'
```
```
Git, Subversion, Mercurial.
```

随文本到达实时拼接流式文本：

```bash
agy -p "Explain what a merge conflict is in two sentences." --output-format stream-json \
  | jq -j 'select(.event=="step_update") | .step_update.text_delta // empty'
```

从终态 `result` 事件读 token 用量：

```bash
agy -p "In one sentence, what is a git rebase?" --output-format stream-json \
  | jq 'select(.event=="result") | .result.usage'
```

> **提示**：拼接 `text_delta` 片段时用 `jq -j`（不换行输出），这样 jq 不会在片段之间插入换行。

## 续接对话

Headless 运行默认**无状态**。用 `--continue`（`-c`）续接最近的对话，或用 `--conversation` + 之前某次运行返回的 `conversation_id` 续接指定对话：

```bash
# 续接最近的对话。
agy -p "Now explain your previous answer in more detail" --continue

# 按 ID 续接指定对话。
agy -p "Summarize what we discussed" --conversation 055a398f-db14-4c5f-abbb-1bf03f8120a7
```

## 选择模型、努力档位或 agent

先列出可用的模型 slug，再为本次运行钉住一个：

```bash
agy models
```
```
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
...
```
```bash
# 按 slug 钉住模型。
agy -p "Reverse the string antigravity." --model gemini-3.5-flash-medium

# 设置推理努力档位（low、medium 或 high）。
agy -p "Outline a plan to add caching to this service." --effort high

# 选择一个 agent（用 `agy agents` 列出）。
agy -p "Review this function for edge cases." --agent <agent-name>
```

与交互式 UI 不同，headless 模式在 `--model` 指定未知模型时**不会静默降级**。它会以 `ERROR` 状态非零退出，这样被钉住的流水线会**响亮地失败**，而不是跑错模型。

## Headless 模式下的权限

Headless 模式里没有交互式提示，所以本应请求确认的工具由**策略**处理。

默认情况下，CLI 尊重你设置里的权限模式。一个需要审批却无法获得审批的工具会被**软拒绝（soft-denied）**：运行继续、退出 0，并向 stderr 打印一条通知，指明工具名及如何放行它。**在活动工作区内读写文件是自动放行的**；而像 shell 命令这类动作默认为 `Ask`，在 headless 模式下会被软拒绝，除非你授予它们。

通过在 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 下加一条 `action(target)` 规则来提前授予工具：

```json
{
  "permissions": {
    "allow": [
      "command(git)",
      "command(npm run (build|lint|test))",
      "write_file(src/)"
    ]
  }
}
```

要为一次运行自动批准每个工具，传 `--dangerously-skip-permissions`：

```bash
agy -p "Run the test suite and report failures" --dangerously-skip-permissions
```

> **警告**：`--dangerously-skip-permissions` 会批准所有工具调用，包括文件写入和命令执行。除非你完全信任 prompt 和环境，否则优先用范围化的 `permissions.allow` 规则。完整规则语法见 Permissions。

## 处理退出码和错误

成功的运行退出 0。未能产出响应的运行以非零退出并把原因写到 stderr。在 `json` 和 `stream-json` 模式下，失败还会出现在 `status` 和 `error` 字段里。

例如，钉住一个未知模型会退出 1 并返回一个错误信封：

```bash
agy -p "hi" --model does-not-exist-model --output-format json; echo "exit=$?"
```
```json
{
  "conversation_id": "",
  "status": "ERROR",
  "response": "",
  "error": "invalid model selection (--model \"does-not-exist-model\" --effort \"\"): model does-not-exist-model is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.6 Flash (High)\n  ...",
  "duration_seconds": 0,
  "num_turns": 0,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 0
  }
}
```
```
exit=1
```

`status` 字段报告运行的终态：

| 状态 | 含义 |
|---|---|
| `SUCCESS` | 运行完成并产出了响应 |
| `ERROR` | 运行以错误结束 |
| `CANCELED` | 运行被取消 |
| `INTERRUPTED` | 运行被中断（例如 SIGINT） |
| `INVALID` | 运行进入无效状态 |
| `WAITING` | 运行在等待输入时结束 |
| `RUNNING` | 运行未达到终态 |

默认情况下，一个运行最多等待响应 5 分钟。用 `--print-timeout` 调整上限：

```bash
agy -p "Summarize the design tradeoffs of optimistic locking." --print-timeout 15m
```

## Flag 参考

| Flag | 默认 | 说明 |
|---|---|---|
| `-p`, `--print`, `--prompt` | — | 非交互式运行单条 prompt 并打印响应 |
| `--output-format` | `text` | 输出格式：`text`、`json` 或 `stream-json` |
| `--json-schema` | — | schema 字符串或文件路径，强制结构化输出 |
| `--model` | — | 本次运行的模型 slug（见 `agy models`） |
| `--effort` | — | 推理努力档位：`low`、`medium` 或 `high` |
| `--agent` | — | 本次运行的 agent（见 `agy agents`） |
| `--continue`, `-c` | `false` | 续接最近的对话 |
| `--conversation` | — | 按 ID 续接对话 |
| `--dangerously-skip-permissions` | `false` | 自动批准所有工具权限请求 |
| `--print-timeout` | `5m` | 等待响应的最长时间 |
| `--sandbox` | `false` | 启用终端沙箱限制运行 |

## 示例：在 CI 里运行 agent

出错则让 job 失败，并保存响应：

```bash
#!/usr/bin/env bash
set -euo pipefail

result=$(agy -p "Name three popular version control systems, comma-separated." \
  --output-format json \
  --print-timeout 10m)

status=$(echo "$result" | jq -r '.status')
if [[ "$status" != "SUCCESS" ]]; then
  echo "Agent run failed: $(echo "$result" | jq -r '.error')" >&2
  exit 1
fi

echo "$result" | jq -r '.response' > result.txt
```

## 下一步

- **Prompting & Interaction**：为 agent 写有效的 prompt。
- **Permissions**：配置 allow / deny / ask 规则。
- **Background Tasks & Subagents**：把工作委派给专门的 agent。
- **Reference**：完整的命令与 flag 参考。

---

> **CyberSlots 集成备注（本页是 AntigravityAdapter 的核心依据）**：
> - **驱动方式**：`--output-format stream-json`，把 `init → step_update(N) → result` 映射到既有 think/tool/message 事件流；`result.usage` 喂额度看板。信封与 codex/opencode 同构。
> - **切号后可直接用**：headless 用「缓存凭据」= keyring 条目 `gemini:antigravity`。CyberSlots `CredWrite` 覆写 keyring 后 headless 立即读到新账号（已端到端实测，见 `../antigravity-integration.md §3.6`）。CI/无终端环境未认证会直接报错退出、不挂起——切号写 keyring 正好绕开交互登录。
> - **续接**：`--continue`/`-c` 接最近；`--conversation <id>` 接指定。跨账号续接须自建「任务↔conversation_id」映射后显式 `--conversation`（`-c` 的官方缓存不区分账号，见 `commands/resume.md`）。
> - **官方坐实 `step_type` 四值**：`user_input`/`agent_response`/`tool`/`checkpoint`（本项目另观测到 `error_message`/`unknown`）。
> - **权限**：headless 无交互提示，需审批工具**软拒绝**（继续跑、退出 0、stderr 提示）。赛马全自动：预写 `permissions.allow` 白名单（如 `command(git)`/`command(npm run (build|lint|test))`/`write_file(src/)`），或 `--dangerously-skip-permissions`（=`permission_mode: always-proceed`，谨慎，建议配 `--sandbox`）。
> - **模型钉死会响亮失败**：未知 `--model` 直接 `ERROR` 非零退出，不静默降级——赛马调度须传合法 slug。
> - **超时**：默认 5m，长任务用 `--print-timeout`（如 `15m`）。
