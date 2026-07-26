/**
 * Fork probe — does `kimi acp` (CLI 0.29.1) actually implement
 * session/fork (SDK unstable_forkSession)? Phase-4 sidechat gate.
 *
 * Flow: initialize → session/new → short prompt → unstable_forkSession
 * → prompt inside the fork ("what did we just talk about?") to verify
 * the fork carries context. Prints raw responses / errors verbatim.
 *
 * Usage: node scripts/probe-fork.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIMI_HOME = join(ROOT, '.dev', 'kimi-home');
const WORK_DIR = join(ROOT, '.dev', 'workdir');
mkdirSync(WORK_DIR, { recursive: true });

const log = (...a) => console.log('[fork-probe]', ...a);
let shuttingDown = false;
process.on('unhandledRejection', (e) => {
  if (!shuttingDown) {
    console.error('[fork-probe] unhandledRejection:', e);
    process.exit(1);
  }
});

function resolveKimiSpawn() {
  const mainMjs = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  if (existsSync(mainMjs)) return { command: process.execPath, args: [mainMjs, 'acp'] };
  return { command: 'kimi', args: ['acp'], shell: true };
}

function withTimeout(promise, ms, tag) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const texts = { current: '' };
const clientImpl = {
  async sessionUpdate(n) {
    const u = n.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') texts.current += u.content.text;
  },
  async requestPermission(p) {
    const pick = (p.options ?? [])[0];
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
  },
  async readTextFile() {
    throw new Error('disabled');
  },
  async writeTextFile() {
    throw new Error('disabled');
  },
};

async function main() {
  const { command, args, shell } = resolveKimiSpawn();
  const child = spawn(command, args, {
    cwd: WORK_DIR,
    shell: shell ?? false,
    env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) console.error('  [kimi:stderr]', l);
  });

  const conn = new ClientSideConnection(() => clientImpl, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));

  const init = await withTimeout(conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }), 30_000, 'initialize');
  log('sessionCapabilities:', JSON.stringify(init.agentCapabilities?.sessionCapabilities ?? null));

  const sess = await withTimeout(conn.newSession({ cwd: WORK_DIR, mcpServers: [] }), 30_000, 'session/new');
  log('session:', sess.sessionId);

  texts.current = '';
  await withTimeout(
    conn.prompt({ sessionId: sess.sessionId, prompt: [{ type: 'text', text: '记住这个暗号：蓝色大象42。只回复"已记住"。' }] }),
    90_000,
    'prompt#1',
  );
  log('prompt#1 reply:', texts.current.trim().slice(0, 100));

  log('calling unstable_forkSession …');
  let fork;
  try {
    fork = await withTimeout(conn.unstable_forkSession({ sessionId: sess.sessionId, cwd: WORK_DIR, mcpServers: [] }), 30_000, 'session/fork');
    log('fork response:', JSON.stringify(fork).slice(0, 400));
  } catch (err) {
    log('❌ fork FAILED:', err?.message ?? err);
    log('→ 结论: kimi acp 未实现 session/fork，sidechat 需走「新 session + 历史重放」降级路径');
    shuttingDown = true;
    child.kill();
    process.exit(2);
  }

  texts.current = '';
  await withTimeout(
    conn.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: '暗号是什么？只回复暗号本身。' }] }),
    90_000,
    'prompt#2(fork)',
  );
  log('fork reply:', texts.current.trim().slice(0, 100));
  const carried = texts.current.includes('蓝色大象') || texts.current.includes('42');
  log(carried ? '✅ fork 携带上下文 — sidechat 原生路径可用' : '⚠️ fork 成功但未携带上下文');

  shuttingDown = true;
  child.kill();
  process.exit(carried ? 0 : 3);
}

main().catch((e) => {
  console.error('[fork-probe] fatal:', e);
  shuttingDown = true;
  process.exit(1);
});
