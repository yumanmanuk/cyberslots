/**
 * NewSessionView — landing pane: pick engine (kimi / codex), then Chat
 * (no workspace) or Work (bound to a project folder).
 */

import { useState } from 'react';
import { FolderOpen, MessageCircle, Loader2, Sparkles } from 'lucide-react';

import type { EngineId } from '@shared/types';
import { useChatStore } from '../store/chatStore';

const ENGINES: Array<{ id: EngineId; label: string; hint: string }> = [
  { id: 'kimi', label: 'Kimi', hint: '主引擎 · ACP · swarm/goal 原生' },
  { id: 'codex', label: 'Codex', hint: '副引擎 · app-server · 经内置代理路由' },
];

export default function NewSessionView(): JSX.Element {
  const createSession = useChatStore((s) => s.createSession);
  const creating = useChatStore((s) => s.creating);
  const [engine, setEngine] = useState<EngineId>('kimi');
  const [error, setError] = useState<string | null>(null);

  const start = async (cwd: string): Promise<void> => {
    setError(null);
    try {
      await createSession({ engine, cwd });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFolder = async (): Promise<void> => {
    const folder = await window.cyberslots.dialogPickFolder();
    if (folder) await start(folder);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8">
      <div className="flex flex-col items-center gap-2">
        <Sparkles size={28} className="text-accent" />
        <h1 className="text-xl font-semibold">开始新会话</h1>
        <p className="text-ui text-ink-soft">选择模式 — Chat 纯聊天，Work 绑定项目目录让 AI 读写代码</p>
      </div>

      <div className="flex items-center gap-1 rounded-xl border border-line bg-bg-panel p-1">
        {ENGINES.map((e) => (
          <button
            key={e.id}
            title={e.hint}
            onClick={() => setEngine(e.id)}
            className={`rounded-lg px-4 py-1.5 text-ui transition ${
              engine === e.id ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="flex gap-4">
        <button
          disabled={creating}
          onClick={() => void start('')}
          className="flex w-52 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-6 py-8 shadow-sm transition hover:border-accent hover:shadow-md disabled:opacity-50"
        >
          <MessageCircle size={22} className="text-accent" />
          <div className="text-sm font-medium">Chat</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">不绑定目录，当普通 AI 聊天用</div>
        </button>
        <button
          disabled={creating}
          onClick={() => void pickFolder()}
          className="flex w-52 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-6 py-8 shadow-sm transition hover:border-accent hover:shadow-md disabled:opacity-50"
        >
          <FolderOpen size={22} className="text-accent" />
          <div className="text-sm font-medium">Work</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">选择项目目录，AI 可读写文件执行任务</div>
        </button>
      </div>

      {creating && (
        <div className="flex items-center gap-2 text-ui text-ink-soft">
          <Loader2 size={14} className="animate-spin" /> 正在启动 {engine} 引擎…
        </div>
      )}
      {error && <div className="max-w-lg rounded-lg bg-err/10 px-4 py-2 text-ui text-err">{error}</div>}
    </div>
  );
}
