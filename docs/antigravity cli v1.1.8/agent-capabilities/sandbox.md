# 沙箱（Sandbox）

> 强制原生操作系统进程隔离，管理执行隔离边界，保护你的本地工作站。

## 安全模型

因为自主开发 agent 会在你的工作区直接运行本地终端命令、编辑源代码、执行测试，维护一个安全的工作站环境至关重要。Antigravity CLI 集成了原生的**终端沙箱（Terminal Sandbox）**来限制破坏性 shell 操作或未授权的远程网络调用。

## 原生 OS 隔离

不同于拖慢执行速度的重型虚拟容器或隔离虚拟机，Antigravity 使用轻量、原生的操作系统内核工具来创建安全进程环，且执行开销为零：

| 操作系统 | 沙箱工具 | 安全特性 |
|---|---|---|
| Linux | `nsjail` | 开源进程隔离器，利用内核命名空间和 cgroups 限制 CPU、内存和路径可见性。 |
| macOS | `sandbox-exec` | 原生系统工具，强制策略配置文件来限制绝对文件系统访问和原始 TCP 查询。 |
| Windows | `AppContainer` | 桌面安全隔离环，隔离文件系统权限和注册表可见性。 |

## 激活沙箱

你直接在全局偏好设置里配置沙箱：

```
~/.gemini/antigravity-cli/settings.json
```

### 沙箱配置

把沙箱开关加进你的设置配置：

```json
{
  "enableTerminalSandbox": true
}
```

- `enableTerminalSandbox`（boolean，默认：`false`）：把 agent 启动的所有本地执行命令限制在 OS 隔离环内。

## 沙箱下的交互式审批

当 agent 尝试运行终端工具或 shell 命令时，TUI prompt 块会根据你的沙箱状态动态适配：

- **沙箱已启用时**：prompt 面板提供一个临时逃逸选项：

  ```
  Do you want to proceed?
  1. Yes
  2. Yes, and run without sandbox restrictions
  3. No
  ```

  选择选项 2 仅为那一次执行绕过隔离屏障。

- **沙箱已禁用时**：prompt 允许你为某个风险命令强制开启隔离：

  ```
  Do you want to proceed?
  1. Yes
  2. Yes, and run in sandbox
  3. No
  ```

## 参见

- **Permissions Engine**：配置细粒度 allow/deny 策略规则。
- **Plugins & Skills**：创建你自己的自定义技能斜杠命令。
- **Settings, Rendering & Keybindings**：自定义键盘热键和缓冲区。

---

> **CyberSlots 集成备注**：Windows 用 AppContainer。赛马若要在 sandbox 内自动跑风险命令，需 `enableTerminalSandbox: true` + `toolPermission: proceed-in-sandbox`。注意：交互态下 sandbox 开/关都会弹三选一审批（已启用时额外提供“无沙箱运行”逸出，禁用时提供“入沙箱运行”）——headless 全自动需用 `toolPermission: always-proceed` / `proceed-in-sandbox` 避开这些提示。
