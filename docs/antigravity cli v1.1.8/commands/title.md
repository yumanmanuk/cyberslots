# 窗口标题命令（/title）

> 交互式配置动态终端窗口标题。

## 概述

`/title` 命令允许你开关终端窗口标题功能，或显式设置其状态。启用后，终端标题栏会动态更新，显示当前使用的模型、工作区和 agent 状态。

关于如何编写自定义脚本来格式化窗口标题，参见概念页《终端标题自定义指南》（Terminal Title Customization Guide）。

## 交互式切换

运行 `/title` 命令即可控制窗口标题功能。

开关此功能：

```text
/title
```

显式启用：

```text
/title on
```

显式禁用：

```text
/title off
```

## 延伸阅读

- 终端标题自定义指南（Terminal Title Customization Guide）。[未提供]
- CLI 参考：见 [`../reference.md`](../reference.md)。
