# 安装与认证（Installation & auth）

> 安装 Antigravity CLI、配置企业要求、建立安全的已认证会话。

## 安装

Antigravity CLI 原生运行于 macOS、Linux 和 Windows。用下面的平台专属脚本在你的系统上安装或升级二进制。

### macOS 和 Linux

执行原生安装脚本，把可执行文件下载安装到 `~/.local/bin/agy`：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

### Windows

安装脚本会把 `agy` 二进制注册到你的本地用户目录：`C:\Users\<Username>\AppData\Local\agy\bin`（`<Username>` 是你当前的 Windows 用户配置名）。

**PowerShell**：打开 PowerShell 执行以下安装脚本：

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

**CMD**：打开标准命令提示符执行：

```cmd
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

### 安装 flag

执行安装脚本时可追加以下自定义 flag：

- `--skip-aliases`：跳过 shell 配置文件的别名清理（阻止脚本清除或更新旧的 `agy` / `antigravity` shell 别名）。
- `--skip-path`：跳过 shell 配置文件的 PATH 追加（阻止脚本修改你 shell 配置文件里的动态环境变量）。

## 认证工作流

Antigravity CLI 使用安全凭据和令牌配置（token profiles）与共享的 agent harness 通信。

### 本地静默 keyring 登录

在本地机器上启动 `agy` 时，CLI 会尝试访问你操作系统的**原生安全 keyring**（如 Apple Keychain、Linux Secret Service/dbus，或 **Windows 凭据管理器**）。若找到有效的令牌配置，CLI 会**静默认证**你的会话，不打开浏览器。

若没找到已保存的会话：

1. CLI 自动启动你本地的默认 Web 浏览器。
2. 用你已获批的账号凭据登录。

### 远程 SSH OAuth 流程

通过 SSH 运行时，CLI 会检测到远程连接环境。因为无法启动本地 Web 浏览器，CLI 会发起一个**手动 URL 循环**：

1. 在你的远程终端会话里启动 `agy`。
2. CLI 检测到 SSH 环境，打印一个唯一的、安全的授权 URL。
3. 复制该 URL，粘贴到你本地机器上的 Web 浏览器里。
4. 用已获批的凭据登录并完成认证。
5. 浏览器显示一个唯一的字母数字授权码。
6. 复制该码，回到远程 SSH 终端，粘贴到提示符里。

## 管理你的会话

终止会话会清除活动凭据和本地缓存目录。

### 登出

要断开你的账号并从操作系统 keyring 里清除已保存的认证配置，在 CLI 输入框里运行：

```
/logout
```

## 下一步

完成安装和认证后，开始与本地 agent 交互：

- **Tutorial**：用 agent 创建并运行一个基础 Python 项目。
- **Prompting & Interaction**：探索多行文本编辑、中断命令、终端媒体粘贴。
- **Permissions & Sandbox**：配置安全的文件系统目录和命令限制。

---

> **CyberSlots 集成备注（认证机制的官方坐实）**：
> - **认证真源 = OS keyring**（Windows 凭据管理器条目 `gemini:antigravity`）。「本地静默 keyring 登录」官方明写：启动 `agy` 先查 keyring，命中即静默认证、不开浏览器——这正是 CyberSlots **`CredWrite` 覆写 keyring 即可程序化切号**的官方依据（已端到端实测，见 [`../antigravity-integration.md`](../antigravity-integration.md) §3.6）。
> - **`/logout` 从 keyring 清除令牌**——反向印证 keyring 是权威凭据源。切号时不用 `/logout`，直接覆写 blob 即可。
> - **Windows 安装路径** `C:\Users\<Username>\AppData\Local\agy\bin`（= `%LOCALAPPDATA%\agy\bin\agy.exe`）——CyberSlots 调 agy 前需把此目录加进 PATH（`$env:Path += ";$env:LOCALAPPDATA\agy\bin"`）。
> - **首启无会话会开浏览器交互登录**——headless/无终端环境（含 CyberSlots 后台调用）必须**预先写好 keyring**，否则会挂在浏览器登录或报 authentication required（呼应 headless-mode.md）。
> - `--skip-path` / `--skip-aliases` 可控安装副作用；若集成内置 agy 分发，用这两个 flag 避免污染用户 shell 配置。
