# Model Quotas（`/usage`）

> 查看你当前生效的模型额度用量，并刷新你的配置。

## 概述

Antigravity CLI 提供 `/usage` 命令（别名 `/quota`）帮你监控资源消耗。运行时，该命令会**从后端刷新你的模型配置和额度状态**，并打开一个交互式 TUI 面板。

## 查看用量

打开 Model Quotas 面板：

1. 在 prompt 输入框里输入 `/usage`（或 `/quota`）。
2. 按 `Enter`。

```
/usage
```

面板实际形态（Quota & Credits TUI，据官方截图）：

```
└ Models & Quota

  Account:

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
  [██████████████████████████████░░░]  93.79%
   94% remaining · Refreshes in 155h 41m

CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit
  [███████████████████████░░░░░░░░░░]  73.41%
   73% remaining · Refreshes in 46h 38m

  Within each group, models share a weekly limit. Quota is consumed
  proportionally to the cost of the tokens. Thus, limits will last longer with
  shorter tasks or using more cost-effective models. Your weekly limit is tied
  directly to your individual tier.

↑/↓ Scroll · pgup/pgdown Page · ctrl+end Bottom · ctrl+home Top · esc Close
```

> **额度模型要点（截图内说明文字）**：同一分组内的模型**共享一个周额度（Weekly Limit）**；额度按 **token 成本按比例消耗**——因此任务越短、或用越具性价比的模型，额度就越经久。你的周额度直接与你的个人 tier 绑定。分组按截图为 **GEMINI MODELS**（Gemini Flash、Gemini Pro）与 **CLAUDE AND GPT MODELS**（Claude Opus、Claude Sonnet、GPT-OSS）两组，各自独立计时刷新（`Refreshes in …`）。

## 交互面板功能

面板展示：

- **Model Quotas**：每个受支持模型的用量上限与剩余请求数 / token 的明细（例如 Gemini 3.5 Flash、Gemini 3.1 Pro）。
- **Active Refresh**：打开此面板时，CLI 会自动触发一次对磁盘上以及后端服务的额度**新鲜检查**。

## 导航控制

用以下键盘快捷键在面板内导航：

| 键 | 动作 |
|---|---|
| `↑` / `↓`（或 `j` / `k`） | 上下滚动一行 |
| `PgUp` / `PgDn` | 上下滚动一页 |
| `g` / `G` | 跳到列表顶部 / 底部 |
| `Esc`（或 `q`） | 关闭面板返回 prompt |

> 截图底部状态栏另标注了 `ctrl+end` 到底部 / `ctrl+home` 到顶部，与 `g`/`G` 等效。

## 下一步

- **CLI Reference**：查看所有可用斜杠命令与键位绑定。
- **Settings & Rendering**：配置你的默认模型和 credit 用量偏好。

---

> **CyberSlots 集成备注**：
> - `/usage` 是**交互式 TUI**，headless 无对应 flag，**无法脚本化读取**。CyberSlots 的额度看板仍走 cockpit 链路（enterprise client 现刷 → `loadCodeAssist` 取 project_id → `retrieveUserQuotaSummary`），可一次性扫全 13 个账号且不干扰 agy 当前会话，见 [`../../antigravity-integration.md`](../../antigravity-integration.md) §6。
> - **额度是「分组周额度」而非按模型独立**：Gemini 组（Flash/Pro）与 Claude+GPT 组（Opus/Sonnet/GPT-OSS）各一条 Weekly Limit，两组刷新倒计时独立。赛马调度的轮换判据应**按组**评估剩余量，而不是按单模型。
> - **按 token 成本比例扣减**：同一分组内换用更便宜的模型可显著延长额度寿命——这给「额度将尽时降档模型」提供了官方依据（配合 `--model`/`--effort`）。
> - **`Refreshes in Xh Ym`** 是周额度重置倒计时，可用于"等待重置 vs 立即切号"的决策；cockpit 的 `retrieveUserQuotaSummary` 返回的重置时间应与此一致。
> - **`Account:` 行**证明面板与当前 keyring 账号绑定——切号（`CredWrite` 覆写 `gemini:antigravity`）后 `/usage` 显示的即为新账号额度。
