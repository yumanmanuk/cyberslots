# probe-browser-use-findings.md — 受管浏览器 / 桌面控制 Phase 0 探针地面真值

探针脚本：`scripts/probe-browser-cdp.mjs`（P1）、`scripts/probe-nutjs.mjs`（P2）、
`scripts/probe-omp-computer.mjs`（P3）、`scripts/probe-mcp-channel.mjs`（P4）。
运行时间 2026-08-05，机器：Windows 11 x64，node v20.19.4，
Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`，
omp（`%LOCALAPPDATA%\omp\omp.exe`），kimi-code（`%APPDATA%\npm\node_modules\@moonshot-ai\kimi-code\dist\main.mjs`，`node <path> acp`）。

## 1. P1 — playwright-core 驱动外部 Chrome（CDP）→ GO

`scripts/probe-browser-cdp.mjs` 全 12 项 PASS，退出码 0。实测要点：

- **spawn/就绪**：自由端口（`net.createServer listen 0`）+ `--remote-debugging-port`
  + `--remote-allow-origins=*` + 独立 mkdtemp `user-data-dir`，`/json/version`
  轮询数秒内就绪（30s/250ms 上限内）。
- **connectOverCDP**：`chromium.connectOverCDP('http://127.0.0.1:<port>')` 一次成功；
  默认上下文取已开页 + `setViewportSize(1280x800)` 正常。
- **七工具原语**（对齐 `policy.BROWSER_TOOLS`）全部实测通过：
  navigate_page（data: 页 h1=probe）、click（onclick 计数=1）、fill（password
  字段 12 字符写入读回一致）、scroll_page（`mouse.wheel(0,600)` → scrollY=600）、
  take_screenshot（jpeg q50 = **7434B / 7.3KB**，远低 600KB 预算）、
  evaluate_script（document.title=probe-page）、list_pages（pages=1）。
- **profile 隔离**：临时 user-data-dir 探测后被填充（顶层 35 条目），
  用户日常 Chrome profile 全程未触碰（探针不读不写默认数据目录）。
- **CDP 断连语义（关键实测）**：`browser.close()` **只断开 CDP 客户端，不杀外部
  Chrome**（close 后 `/json/version` 仍可达）—— BrowserService.stop() 必须显式
  树杀（`killEngineTree`），现有设计已覆盖。taskkill 树杀生效（杀后无
  `probe-cdp-profile` 命令行的 chrome 进程残留；脚本内 500ms 即查端口仍见存活，
  是 taskkill 异步 + 轮询过早的时序假象，事后复核进程已清）。

结论：**playwright-core + 外部系统 Chrome 的驱动链路完全可行**，BrowserHost 方案
（懒启动单例 → 自由端口 → spawn → 轮询就绪 → stop 树杀）无阻塞项。

## 2. P2 — nut-js 动作库可用性 → GO（打包期待办已登记）

`scripts/probe-nutjs.mjs` 只读模式 3 项 PASS、`--move` 模式 4 项 PASS，退出码 0。实测：

- **免 rebuild 加载**：`@nut-tree-fork/nut-js@4.2.6` 在 node v20.19.4（ABI 115,
  win32 x64）直接 `import { screen, mouse, keyboard, Point }` 成功 —— 原生件走
  `@nut-tree-fork/libnut-win32/build/Release/libnut.node` 预编译包，无 node-gyp。
- **只读查询**：`screen.width()/height()` = 1920x1080；`mouse.getPosition()` 正常返回。
- **位移**（--move）：`(744,950) → (754,960) → (744,950)` 往返误差 ≤1px。
- **Electron 兼容**：本探针只验证 node 侧（`process.versions.electron` 缺失）。
  Electron 33 ABI 匹配属打包期问题，未实测 —— 若预编译 .node 与 Electron ABI
  不符，需打包钩子内 rebuild（Phase 3 决定）。
- **打包待办（REMARK，Phase 3 必须）**：① nut-js 现为 **devDependency**，
  electron-builder 不会打进 app 包 → 须移到 dependencies；② 原生 `.node`
  须配 **asarUnpack**（asar 内无法 dlopen）；③ libnut 按平台分包
  （win32/darwin/linux），跨平台构建按 target 保留对应包。

## 3. P3 — omp 原生 browser/computer 面（三审批档事件可见性）→ NO-GO（维持黑名单）

`scripts/probe-omp-computer.mjs --model kimi/k3`，omp/17.1.8，退出码 0（证据收集）。
方法：每审批档全新 `omp acp` + mkdtemp cwd，`PI_CODING_AGENT_DIR` 指向临时隔离目录
（models.yml/config.yml 种子自 `~/.omp/agent` **只读拷贝**，探针结束重试删除），
prompt `/browser`（无工具事件则回退「请使用 browser 工具打开 https://example.com 并截图」），
request_permission 一律自动 allow-once。

**探针自身踩坑（已修正并复测，留档）**：
- `PI_CODING_AGENT_DIR` 即 omp 的 agent 目录**本体** —— 种子文件须放其根；
  首轮放 `<dir>/agent/` 子目录 → `models --json` 0 条 → prompt 秒报 Internal error。
- 隔离目录下 `config.yml` 的 `modelRoles.default=google-antigravity/...` 不可解析
  （credentials 不在种子里）→ **spawn 必须显式 `--model`**（同 probe-omp-findings §9），
  本次用 `kimi/k3`（apiKey 内联于 models.yml，沙箱可用）。

**`/browser` 斜杠命令文本**：三档均只回 `Browser mode: visible|headless` 文本 +
`stopReason=end_turn`，**零工具事件** —— 斜杠命令经 ACP prompt 文本通道只是状态回显，
不触发任何浏览器动作。真正的动作面在自然语言 prompt 下才出现。

**三档矩阵（自然语言 prompt「打开 example.com 并截图」实测）**：

| 审批档 | tool_call | tool_call_update | request_permission | browser 工具可见 | 动作结果 |
|---|---|---|---|---|---|
| ask（always-ask） | 1 | 1 | **0** | 是 | **自动被拒**（agent 自述 "The user denied the tool call"），未执行 |
| write | 2 | 2 | **0** | 是 | 两次尝试均**自动被拒**（"denied by the user twice"），未执行 |
| yolo（auto-approve） | 2 | 1 | **0** | 是 | 首次调用**实际执行**（open 超时后模型自主改 `wait_until=domcontentloaded, timeout=60` 重试），全程无审批卡点；探针 45s 上限截断 |

**事件形态（三档一致，关键样本）**：
```json
{"sessionUpdate":"tool_call","title":"Opening example.com","kind":"execute","status":"pending",
 "rawInput":{"path":"xd://browser","content":"{\"action\":\"open\",\"url\":\"https://example.com\",\"wait_until\":\"load\"}"}}
```
机制（模型 thought 自述 + rawInput 佐证）：omp 的 browser 动作 = **write 工具向虚拟路径
`xd://browser` 写 JSON 指令**（`{"action":"open",...}`），事件面是标准 `tool_call(kind=execute)`。

**判定：NO-GO（维持黑名单）**。证据链：
- 可见性 ✅：三档 browser 动作都以 `tool_call`/`tool_call_update` 进事件流（可审计、可打卡展示）。
- 可拦截性 ❌：`request_permission` **三档全部为 0** —— 客户端拿不到审批请求，
  无法按动作放行/拒绝。ask/write 档是 omp **内部自动拒**（安全但功能不可用，
  模型只能回报受阻）；yolo 档则**自动执行**（动作真的跑了，无任何客户端卡点）。
- 两种形态都不满足「客户端可见 + 可按动作拦截」的解黑名单条件
  （探针脚本打印的建议判定同为 NO-GO；注意其概括文案把 write 档并入「自动执行」，
   实测 write 档是被拒而非执行，以本表为准）。
→ `/browser`、`/computer` 维持 GUI 黑名单；omp 单引擎过渡增益不可行，
  受管浏览器能力走自研 MCP 通道（即 P4 验证对象）。


## 4. P4 — ACP mcpServers 通道（kimi + omp）→ GO（kimi 全链路）/ omp 保留通过

`scripts/probe-mcp-channel.mjs --model kimi/k3`，退出码 0（≥1 引擎 PASS）。
探针自身兼作 MCP stdio server（`--serve`，cs_echo 单工具，风格同
`src/main/browser/mcpServerScript.ts`；自测 initialize/tools/list/tools/call/-32601 全对）。

### kimi（Kimi Code CLI 0.31.0）— PASS，全链路实测

`node <main.mjs> acp`，`session/new` 接受 `mcpServers: [{name:'cs-probe',
command: node, args: [probe, '--serve'], env: []}]`：

```
tool_call  title="mcp__cs-probe__cs_echo" kind=other status=pending
tool_call_update  status=in_progress（rawInput 流式 {"text":"ping"}）
⇐ session/request_permission: mcp__cs-probe__cs_echo → 探针自动 allow-once
tool_call_update  status=completed  rawOutput="ECHO:ping"
agent 文本: 工具返回结果原样如下： ```ECHO:ping```
```

**MCP 工具在 kimi 侧完整落地并可按动作拦截**：原生 `mcp__<server>__<tool>` 工具面 +
每次调用触发 `request_permission`（探针 allow-once 后 completed 并回传 ECHO:ping）。
7.6s 一个回合。这就是 BrowserService.acpMcpServers 设计假设的直接证据。

### omp（oh-my-pi 17.1.8）— PASS（信号达标，含重要保留）

`session/new` 同样接受 mcpServers；模型知道 cs_echo 及其 schema（产出
`{"text":"ping"}`），事件流出现 cs_echo 工具事件（达标信号）。但**调用未真正执行**：
模型先后三条路径全部被自动拒绝（always-ask 档）——

| 尝试 | rawInput | 结果 |
|---|---|---|
| eval 工具 `tool.cs_echo({text:"ping"})` | language=js | failed: `Tool call denied by user: eval` |
| write 工具写 `xd://mcp__cs_probe_cs_echo` | path=xd://… | failed: `Tool call denied by user: write` |
| bash `$ echo {"text":"ping"}` | command | 唯一一次 request_permission（探针 allow-once）后仍 failed: `denied by user: bash` |

- `ECHO:ping` 未返回（ECHO:ping 文本=false）；`request_permission` 仅 1 次且落在
  bash 兜底尝试上，**MCP 调用本身没有审批卡点**。
- 与 P3 同源结论：omp 把**外部 MCP 调用也塞进 `xd://mcp__<server>_<tool>` 虚拟路径 +
  write 工具通道**，always-ask 档对 `xd://` 写一律内部自动拒（不问客户端）。
- 推论：omp 侧要让 MCP 调用真正送达 server，可能需 write/yolo 审批档（P3 yolo 档
  `xd://browser` 确实执行了）—— **未复测，留作 Phase 1 验证项**；若 write/yolo 才放行，
  则 omp 的受管浏览器审批只能继续依赖「主进程 HTTP 出口统一钩子」（mcpServerScript.ts
  设计：不依赖引擎主动发起审批），这条假设本探针未被推翻。

## 5. 总结论

| 探针 | 判定 | 关键证据 |
|---|---|---|
| P1 浏览器 CDP 驱动 | **GO** | 12/12 PASS：外部 Chrome + connectOverCDP + 七原语全通；截图 7.3KB≪600KB；`browser.close()` 不杀外部 Chrome（stop 必须显式树杀，现设计已覆盖） |
| P2 nut-js 动作库 | **GO** | 4/4 PASS：免 rebuild（libnut-win32 预编译），读写/位移全通；Phase 3 待办 = 移 dependencies + asarUnpack + Electron ABI 复验 |
| P3 omp 原生 browser/computer | **NO-GO（维持黑名单）** | 三档 tool_call 可见但 request_permission 全 0：ask/write 自动被拒（功能不可用）、yolo 自动执行（无拦截）——两形态都不满足「可见且可按动作拦截」 |
| P4 ACP mcpServers 通道 | **GO（kimi）/ omp 保留通过** | kimi 全链路（工具落地 + request_permission 拦截 + ECHO:ping 回传）；omp 工具落地、调用意图可见，但 always-ask 档调用被 xd:// 通道自动拒，未送达 server（write/yolo 放行待复测） |

落地含义：
- 受管浏览器主路线（BrowserHost + playwright-core + 自研 MCP server + 主进程出口
  统一钩子）**技术上成立**：P1 证明驱动面，P4 证明 kimi 的 ACP mcpServers 投递面。
- kimi 是受管浏览器一期的**首发引擎**（全链路唯一实测通过）；omp 作为二发，
  须先复测 write/yolo 档 `xd://mcp__*` 放行行为，且无论结果如何都依赖主进程钩子
  做审批（不能指望 omp 的 request_permission）。
- omp 原生 `/browser`、`/computer` 维持黑名单（P3），不存在「omp 单引擎过渡增益」。
- 桌面控制（nut-js）库可用，进入 Phase 1 设计；打包三待办见 §2。

