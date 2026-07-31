/**
 * Main-process i18n — 极简双语助手。渲染层有完整键值字典
 * （renderer/src/i18n.ts），主进程文案多为一次性的错误/系统消息/
 * 通知，就地 L('中文', 'English') 内联双语即可，不另建键表。
 *
 * 语言来源：SettingsStore —— 启动时 initMainLang() 灌入，settingsSet
 * IPC 每次保存后同步。生成的文本随消息持久化，语言切换不回溯翻译
 * （与渲染层 translate() 同语义）。
 */

let currentLang: 'zh' | 'en' = 'zh';

export function setMainLang(lang: string | undefined): void {
  currentLang = lang === 'en' ? 'en' : 'zh';
}

export function mainLang(): 'zh' | 'en' {
  return currentLang;
}

/** 按当前界面语言取 zh/en 文案。 */
export function L(zh: string, en: string): string {
  return currentLang === 'en' ? en : zh;
}
