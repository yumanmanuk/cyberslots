/**
 * 系统 Chrome 解析 —— 受管浏览器只驱动作系统中已装的 Chrome/Edge
 * （playwright-core 不下载浏览器）。解析顺序：显式环境变量 CS_CHROME_PATH
 * → 各平台常见安装路径。找不到时抛错并在信息里引导用户配置
 * CS_CHROME_PATH（渲染层面板会把该错误展示出来）。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

function candidates(): string[] {
  const env = process.env.CS_CHROME_PATH;
  const list = env ? [env] : [];
  if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (root) list.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    // Edge 兜底（Chromium 内核，CDP 兼容；仍属「系统已装浏览器」）。
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (root) list.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return list;
}

/** 解析系统 Chrome/Edge 可执行文件路径；找不到抛错引导配置 CS_CHROME_PATH。 */
export function resolveChromePath(): string {
  for (const p of candidates()) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    '未找到系统 Chrome/Edge。请安装 Chrome，或设置环境变量 CS_CHROME_PATH 指向浏览器可执行文件后重启应用。',
  );
}
