/**
 * Data directory resolution.
 *
 * userData 必须在 app ready 之前决定，因此「自定义数据路径」不能存在
 * userData/settings.json 里（鸡生蛋）。这里用独立的指针文件：
 *   - 打包版：exe 同级 data-path.json
 *   - dev：项目根 .data-path.json
 * 指针文件只放一个字段 `dataDir`（'' 或缺失 = 默认目录）。
 *
 * 优先级：指针文件 → 默认目录（%APPDATA%\CyberSlots）。
 * 目标目录不存在时启动阶段自动创建；创建失败回退默认目录并记日志。
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import { log } from '../log/logger';

/** 指针文件绝对路径（随运行形态切换，保证 dev/打包各自独立）。 */
function pointerFile(): string {
  return app.isPackaged
    ? join(dirname(process.execPath), 'data-path.json')
    : join(app.getAppPath(), '.data-path.json');
}

/** 未配置时的默认数据目录。 */
export function defaultDataDir(): string {
  return join(app.getPath('appData'), 'CyberSlots');
}

/**
 * 启动早期解析并应用数据目录。必须在 app ready 之前调用一次
 * （此后 userData 会被 Chromium 锁定到已定路径）。
 */
export function resolveUserDataDir(): string {
  const fallback = defaultDataDir();
  let override: string | undefined;
  try {
    const f = pointerFile();
    if (existsSync(f)) {
      // BOM 容忍：外部工具（如 PowerShell）重写过的文件可能带 UTF-8 BOM。
      const raw = readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as { dataDir?: unknown };
      const p = typeof parsed.dataDir === 'string' ? parsed.dataDir.trim() : '';
      if (p) {
        if (isAbsolute(p)) {
          override = normalize(p);
        } else {
          log.warn('app.startup', 'data-path.json contains non-absolute path, ignoring', { path: p });
        }
      }
    }
  } catch (err) {
    log.error('app.startup', 'failed to read data path pointer, using default', { fallback }, err);
  }

  const target = override ?? fallback;
  try {
    mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (err) {
    log.error('app.startup', 'data dir unavailable, falling back to default userData', { target, fallback }, err);
    try {
      mkdirSync(fallback, { recursive: true });
      app.setPath('userData', fallback);
    } catch (err2) {
      log.error('app.startup', 'default data dir unavailable', { fallback }, err2);
    }
  }
  return app.getPath('userData');
}

export interface DataDirResult {
  /** 本次启动实际生效的数据目录（重启前不会变）。 */
  current: string;
  /** 已写入指针、待下次启动生效的目录（'' = 恢复默认）。 */
  pending: string;
  /** pending 与 current 相同（设置后重启已生效，或目标即当前目录）。 */
  applied: boolean;
}

/** 写入数据目录指针（'' = 清除指针恢复默认）。目录本身在下次启动时自动创建。 */
export function setDataDir(path: string): DataDirResult {
  const pending = path.trim();
  const f = pointerFile();
  if (pending && !isAbsolute(pending)) {
    const err = new Error(`data dir must be an absolute path: ${pending}`);
    log.error('settings', 'data dir rejected', { path: pending }, err);
    throw err;
  }
  try {
    if (pending) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ dataDir: pending }, null, 2), 'utf8');
    } else if (existsSync(f)) {
      unlinkSync(f);
    }
  } catch (err) {
    log.error('settings', 'failed to persist data path pointer', { file: f, pending }, err);
    throw err;
  }
  const current = app.getPath('userData');
  return { current, pending, applied: pending === current };
}
