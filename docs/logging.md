# CyberSlots 日志系统

> 目标：**本程序的行为全量留痕，引擎的行为归引擎**。调用引擎时由引擎执行
> 产生的日志（CLI 自己的 log 文件、stdout 正文）落在引擎侧不进本系统；
> 属于本程序的内容（生命周期、spawn/exit、协议异常摘要、持久化失败、
> 关键用户操作）一律落本程序日志。

## 1. 存储结构

日志根目录：`userData/logs/`（默认 `%APPDATA%\CyberSlots/logs/`）

| 文件 | 内容 | 写入方 |
|---|---|---|
| `main-YYYY-MM-DD.jsonl` | 主进程日志（按天切分） | 主进程 `log` |
| `renderer-YYYY-MM-DD.jsonl` | 渲染进程日志（同格式） | 渲染 `rlog` → IPC 转发主进程落盘 |
| `compat-audit.jsonl` | 引擎兼容性审计样本库（未知事件/被拒方法/解析失败的原始报文） | compatAudit（独立通道，生命周期独立） |

保留策略：`main-`/`renderer-` 分片保留 **14 天**，启动时自动清理过期分片；
`compat-audit.jsonl` 不参与清理（审计样本库，指纹限量写入，体积受控）。

## 2. 行格式（JSONL，每行一条）

```json
{
  "ts": "2026-07-31T21:03:11.456+08:00",
  "level": "info",
  "scope": "session",
  "msg": "prompt turn completed",
  "data": { "sessionId": "…", "ms": 8421 },
  "err": { "name": "Error", "message": "…", "stack": "…", "code": "ENOENT" }
}
```

- `ts`：本地时区 ISO（带偏移），肉眼友好且可机读。
- `level`：`debug` / `info` / `warn` / `error`。
- `scope`：分层域（见 §4）。
- `data`：结构化上下文，**只放摘要**（id、耗时、计数、路径），
  不放正文/payload（超 4KB 自动截断；敏感字段名 key/token/secret/
  password/authorization/credential 递归打码 `<redacted>`）。
- `err`：错误对象（仅 warn/error 需要时附）。

## 3. 级别约定

| 级别 | 用途 | 落盘 |
|---|---|---|
| `debug` | 高频细节（ai-server stdout、agy 每回合 spawn 等） | 默认不落盘；`CS_LOG_LEVEL=debug` 环境变量开启 |
| `info` | 关键生命周期：启动、会话创建/关闭、引擎 spawn/ready、赛马阶段流转、定时任务触发/完成 | ✔ |
| `warn` | 降级/重试/意外退出但可继续（KAP 降级 ACP、引擎进程意外退出、配额查询失败） | ✔ |
| `error` | 失败：IPC handler 抛错、持久化失败、spawn 失败、未捕获异常 | ✔ |

写盘是同步 `appendFileSync` —— **崩溃前不丢日志**优先于极致性能；
调用侧必须自律：只记摘要，`text.delta` 等事件流**禁止**入日志。

## 4. scope 速查

| scope | 覆盖 |
|---|---|
| `app.startup` / `app.shutdown` / `app.window` / `app.error` | 启动流程、单例锁、孤儿清理、窗口、退出清理、主进程未捕获异常 |
| `session` | 会话创建/prompt 回合（含耗时）/分叉/关闭/删除、引擎事件错误、持久化 |
| `engine.codex` / `engine.kimi` / `engine.omp` / `engine.claude` / `engine.antigravity` | 引擎进程 spawn（命令行摘要）/意外退出（含 stderr 尾部）/spawn 失败/KAP WS 重连 |
| `host.opencode` / `host.kap` | 共享 server 进程 spawn/ready/exit |
| `browser` / `browser.host` | browser use 工具服务：工具调用的摘要审计（动作类型/目标选择器或坐标/耗时/成功否——截图、页面 DOM、输入文本内容**绝不落盘**）、受管 Chrome spawn/就绪/退出、MCP 注册与降级 |
| `proxy.codex` / `proxy.kimi` | 内置 ai-server 路由前端（本程序 utilityProcess 组件） |
| `race` | 赛马创建/阶段流转/用户动作/阶段链失败 |
| `cron` | 定时任务触发/完成/失败/持久化 |
| `fs` / `settings` / `quota` / `titlegen` / `terminal` / `ipc` / `compat` / `log` | 文件操作、配置读写、供应商配额、标题生成、内嵌终端、IPC 错误、兼容性审计、日志系统自身 |
| `changes` | 变更跟踪台账（影子 git init 失败 → 回退能力失效、台账落盘失败/损坏） |
| 渲染侧：`app` / `chat` / `race` / `ui.error` | 启动、关键 IPC 调用失败、全局未捕获异常、ErrorBoundary |

## 5. 代码入口

主进程（任意模块直接 import，无需穿参）：

```ts
import { log } from '../log/logger'; // 深度按实际路径

log.info('session', 'session created', { sessionId, engine });
log.warn('engine.kimi', 'KAP unavailable, falling back to ACP', { detail });
log.error('fs', 'import failed', { src }, err);
```

渲染进程：

```ts
import { rlog } from '../log/logger';

rlog.info('chat', 'session delete requested', { sessionId });
rlog.error('chat', 'sessionPrompt ipc failed', { sessionId }, err);
```

- 渲染日志 600ms 节流批量转发（`log:write` IPC，fire-and-forget），
  `error` 级立即冲刷，页面隐藏/关闭前自动冲刷。
- 所有 IPC handler 已被 `src/main/ipc.ts` 的统一 `handle()` 包装：
  handler 抛错自动记 `error` 日志（含通道名 + 参数摘要），**不需要**
  在 handler 内重复记同一个错误。
- 全局兜底：主进程 `uncaughtException`/`unhandledRejection`、渲染
  `window.onerror`/`unhandledrejection`、React ErrorBoundary 全部入网。

## 6. 边界：什么记、什么不记

| 内容 | 去向 |
|---|---|
| 引擎 CLI 自己的日志文件/滚动日志 | 引擎侧（不动） |
| 引擎 stdout 正文/协议消息流 | **不进本日志**（属引擎执行内容；事件流经 EngineEvent 进 UI） |
| 引擎进程 spawn 命令行摘要（脱敏）、exit code、意外退出时的 stderr 尾部摘录 | 本日志 `engine.*`（排障现场） |
| 未知协议事件/被拒方法/解析失败的原始报文样本 | `compat-audit.jsonl`（审计通道，非运行日志） |
| browser/computer 工具的截图、页面 DOM、页面正文、输入文本内容 | **任何地方都不落盘**（截图仅存内存直供面板/审批卡；日志只记 `browser` scope 摘要；compat-audit 不混用） |
| 密钥/token | 任何地方都不出现（`data` 递归打码 + env 注入不落日志） |

## 7. 查看方式

- 设置 → 引擎总览页底部「程序日志」卡：显示日志目录，一键打开文件夹。
- 反馈问题：附上当天的 `main-*.jsonl` 与 `renderer-*.jsonl`。
- 排查引擎协议漂移：设置页「引擎兼容性诊断」卡 + `compat-audit.jsonl`。

## 8. 新增日志 checklist

1. 选对 scope（§4），新增子域沿用 `域.子域` 分层。
2. `data` 只放摘要：id/计数/耗时/路径；正文、payload、消息流禁止。
3. 失败路径用 `warn`（可恢复/降级）或 `error`（失败），附 `err`。
4. 高频路径（每回合多次）用 `debug`，避免刷屏。
5. 用户操作意图（点击触发）记 `info`，自动流程的内部步骤按需 `debug`。
