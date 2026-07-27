/**
 * Debug probe — dump the FULL initialize / session/new responses and every
 * raw sessionUpdate payload from `kimi acp`, then run one prompt. Diagnoses
 * missing model options / missing response in the app.
 *
 * Usage: node scripts/probe-debug.mjs
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
child.on('exit', (code, sig) => console.log(`[probe] child exit code=${code} sig=${sig}`));

const client = new ClientSideConnection(
  () => ({
    async sessionUpdate(n) {
      const u = n.update ?? {};
      console.log(`[update] ${u.sessionUpdate}:`, JSON.stringify(u).slice(0, 500));
    },
    async requestPermission(p) {
      console.log('[perm]', JSON.stringify(p).slice(0, 300));
      const pick = (p.options ?? [])[0];
      return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
    },
    async readTextFile() { throw new Error('disabled'); },
    async writeTextFile() { throw new Error('disabled'); },
  }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
);

try {
  const init = await withTimeout(
    client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
    30_000,
    'init',
  );
  console.log('[probe] initialize =>', JSON.stringify(init, null, 2));

  const sess = await withTimeout(client.newSession({ cwd: WORK_DIR, mcpServers: [] }), 30_000, 'new');
  console.log('[probe] session/new =>', JSON.stringify(sess, null, 2));

  const res = await withTimeout(
    client.prompt({ sessionId: sess.sessionId, prompt: [{ type: 'text', text: '只回答数字：3+4=?' }] }),
    120_000,
    'prompt',
  );
  console.log('[probe] prompt =>', JSON.stringify(res, null, 2));
  await new Promise((r) => setTimeout(r, 3000));
} catch (err) {
  console.error('[probe] FAILED:', err);
} finally {
  child.kill();
}
