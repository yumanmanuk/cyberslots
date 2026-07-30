# 状态栏命令（/statusline）

> 切换 TUI 状态栏，或配置自定义渲染命令。

## 概述

`/statusline` 命令让你快速开关 TUI 底部的状态栏，或配置一个自定义 shell 命令来动态渲染它，无需手动编辑 settings 文件。

关于如何编写自定义状态栏脚本以及 JSON 状态载荷的 schema，参见概念页《状态栏自定义指南》（Status Line Customization Guide）。

## 用法

用以下参数运行 `/statusline` 控制其行为：

### 切换状态栏

不带参数运行 `/statusline` 即可开关状态栏：

```text
/statusline
```

### 显式启用 / 禁用

可以显式启用或禁用状态栏：

- 启用：`/statusline on` 或 `/statusline enable`
- 禁用：`/statusline off` 或 `/statusline disable`

```bash
/statusline off
```

### 配置自定义命令

要把 agent 状态 JSON 载荷路由给一个自定义脚本、并把它的输出渲染到状态栏，把命令作为参数传入：

```bash
/statusline ~/.gemini/antigravity-cli/statusline.sh
```

这会立即更新你的 settings 并开始运行该脚本来渲染状态栏。

### 恢复默认

要删除自定义命令配置、恢复内置默认状态栏：

```bash
/statusline delete
```

（注：`/statusline reset` 同样支持。）

### 显示帮助

查看快速命令参考：

```bash
/statusline help
```

## 延伸阅读

- 状态栏指南（Status Line Guide）：如何编写自定义脚本、处理 JSON 载荷。[未提供]
- 窗口标题命令（Window Title Command）：见 [`title.md`](./title.md)。
- CLI 参考：见 [`../reference.md`](../reference.md)。
