# AI Credits Command（`/credits`）

> 交互式查看和管理你的 AI Premium credits。

## 概述

`/credits` 命令在 TUI 里打开一个专用面板，展示你当前的 AI Premium credit 余额、消耗历史，以及管理订阅或购买额外 credits 的链接。

关于 credits 如何计量、低额度告警、设置配置的细节，见概念页 **AI Credits Guide**。

## 使用 Credits 命令

查看你的 credit 状态：

1. 在 prompt 输入框里输入 `/credits`。
2. 按 `Enter`。

```
/credits
```

credits 面板会展示：

- **Active Balance**：你剩余的 AI Premium credits。
- **Usage Summary**：当前计费周期内已消耗 credits 的明细。
- **Quick Links**：购买更多 credits 或升级套餐的操作（会打开相应的 Web 门户）。

按 `Esc` 关闭面板返回主 prompt。

## 下一步

- **AI Credits Guide**：了解 credit 消耗、告警和设置。
- **Model Quotas Command**：监控你按模型的 API 额度。
- **CLI Reference**：查看所有可用斜杠命令。

---

> **CyberSlots 集成备注**：
> - AI Premium credits 与「模型周额度」（见 [`usage.md`](usage.md)）是**两套独立资源**：credits 是订阅制的付费余额（可购买/升级），周额度是 tier 绑定的分组配额。
> - `/credits` 同为**交互式 TUI，headless 无对应 flag**，无法脚本化读取；且 credits 属订阅账户维度，CyberSlots 额度调度以「分组周额度」为主判据即可，credits 一般不作为轮换依据。
> - 与设置项 `useG1Credits` 相关：该开关（仅"外部构建"可用）决定计划额度耗尽后是否回落到个人 AI credits，见 [`reference.md`](reference.md) settings.json 表。
