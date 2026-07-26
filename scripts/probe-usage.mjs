/**
 * Usage probe — what sessionUpdate kinds does kimi acp actually push
 * during a short chat turn? Decides whether the per-turn stats line can
 * get real token numbers or needs an estimated fallback.
 *
 * Usage: node scripts/probe-usage.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = join(ROOT, '.dev', 'workdir');
mkdirSync(WORK_DIR, { recursive: true });

function withTimeout(promise, ms, tag) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const mainMjs = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
const spec = existsSync(mainMjs)
  ? { command: process.execPath, args: [mainMjs, 'acp'] }
  : { command: 'kimi', args: ['acp'], shell: true };

const child = spawn(spec.command, spec.args, {
  cwd: WORK_DIR,
  shell: spec.shell ?? false,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));

const kinds = new Map();
const usagePayloads = [];

const client = new ClientSideConnection(
  () => ({
    async sessionUpdate(n) {
      const u = n.update ?? {};
      const kind = u.sessionUpdate ?? '?';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (kind === 'usage_update' || kind === 'session_info_update') {
        usagePayloads.push({ kind, payload: JSON.stringify(u).slice(0, 400) });
      }
    },
    async requestPermission(p) {
      const pick = (p.options ?? [])[0];
      return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
    },
    async readTextFile() { throw new Error('disabled'); },
    async writeTextFile() { throw new Error('disabled'); },
  }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
);

try {
  await withTimeout(client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }), 30_000, 'init');
  const sess = await withTimeout(client.newSession({ cwd: WORK_DIR, mcpServers: [] }), 30_000, 'new');
  console.log('[probe] session', sess.sessionId);

  for (const q of ['只回答数字：3+4=?', '再用一句话介绍土星']) {
    const res = await withTimeout(client.prompt({ sessionId: sess.sessionId, prompt: [{ type: 'text', text: q }] }), 120_000, 'prompt');
    console.log(`[probe] turn done (${q.slice(0, 12)}…) stop=${res.stopReason}`);
    // usage_update 可能滞后于 prompt 响应 — 多等 3 秒再统计。
    await new Promise((r) => setTimeout(r, 3000));
    console.log('[probe] kinds so far:', Object.fromEntries(kinds));
  }
  console.log('[probe] usage/session_info payloads:');
  for (const p of usagePayloads) console.log(' ', p.kind, p.payload);
} finally {
  child.kill();
}
