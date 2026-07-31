/**
 * Probe — kimi CLI 0.30 ACP `thinking` config option 实测：
 * session/new 的 configOptions 是否含 id='thinking'，setSessionConfigOption
 * 切档是否生效并推送 config_option_update。不发 prompt（零 token）。
 *
 * Usage: node scripts/probe-kimi-thinking.mjs
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

const client = new ClientSideConnection(
  () => ({
    async sessionUpdate(n) {
      const u = n.update ?? {};
      if (u.sessionUpdate === 'config_option_update') {
        console.log('[update] config_option_update:', JSON.stringify(u).slice(0, 600));
      }
    },
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } };
    },
    async readTextFile() { throw new Error('disabled'); },
    async writeTextFile() { throw new Error('disabled'); },
  }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
);

const dumpThinking = (opts, tag) => {
  const th = (opts ?? []).find((o) => o.id === 'thinking');
  console.log(`[${tag}] thinking option =>`, th ? JSON.stringify(th) : '（无）');
  return th;
};

try {
  await withTimeout(
    client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
    30_000,
    'init',
  );
  const sess = await withTimeout(client.newSession({ cwd: WORK_DIR, mcpServers: [] }), 30_000, 'new');
  console.log('[probe] sessionId =', sess.sessionId);
  const th = dumpThinking(sess.configOptions, 'session/new');

  if (th) {
    for (const target of ['low', 'max']) {
      // 0.30 wire 字段名是 configId（非 optionId）；两种都试，看哪种被认。
      for (const key of ['configId', 'optionId']) {
        try {
          const res = await withTimeout(
            client.setSessionConfigOption({ sessionId: sess.sessionId, [key]: 'thinking', value: target }),
            15_000,
            `set ${target}`,
          );
          const after = dumpThinking(res?.configOptions, `set(${key})→${target}`);
          console.log(`[probe] set(${key}) thinking=${target} ${after?.currentValue === target ? '✅ 生效' : `❌ currentValue=${after?.currentValue}`}`);
          break;
        } catch (e) {
          console.log(`[probe] set(${key}) thinking=${target} ❌ 被拒: ${e?.message ?? e}`);
        }
      }
    }
  }
} catch (e) {
  console.error('[probe] FAIL:', e?.message ?? e);
} finally {
  child.kill();
  process.exit(0);
}
