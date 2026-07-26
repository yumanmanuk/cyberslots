/**
 * Endpoint probe — pins down which base_url / model / User-Agent combination
 * each API key actually works with, by calling the upstreams directly
 * (no CLI in the loop). Read-only against our own accounts; one tiny
 * completion per combination.
 *
 * Usage: node scripts/probe-endpoints.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const secrets = JSON.parse(readFileSync(join(ROOT, '.dev', 'secrets.json'), 'utf8'));

const CLAUDE_UA = 'claude-cli/2.1.161 (external, cli)';
const KIMI_CLI_UA = 'kimi-code-cli/0.29.1';

/** @type {Array<{name:string, base:string, key:string, model:string, ua?:string}>} */
const combos = [
  // --- kimi key candidates ---
  { name: 'kimi @ moonshot.ai kimi-k3', base: 'https://api.moonshot.ai/v1', key: secrets.kimi.apiKey, model: 'kimi-k3' },
  { name: 'kimi @ moonshot.cn kimi-k3', base: 'https://api.moonshot.cn/v1', key: secrets.kimi.apiKey, model: 'kimi-k3' },
  { name: 'kimi @ kimi.com/coding kimi-for-coding (default UA)', base: 'https://api.kimi.com/coding/v1', key: secrets.kimi.apiKey, model: 'kimi-for-coding', ua: KIMI_CLI_UA },
  { name: 'kimi @ kimi.com/coding kimi-for-coding (claude UA)', base: 'https://api.kimi.com/coding/v1', key: secrets.kimi.apiKey, model: 'kimi-for-coding', ua: CLAUDE_UA },
  { name: 'kimi @ kimi.com/coding k3 (claude UA)', base: 'https://api.kimi.com/coding/v1', key: secrets.kimi.apiKey, model: 'k3', ua: CLAUDE_UA },
  // --- minimax key candidates ---
  { name: 'minimax @ minimaxi.com MiniMax-M3', base: 'https://api.minimaxi.com/v1', key: secrets.minimax.apiKey, model: 'MiniMax-M3' },
  { name: 'minimax @ minimaxi.com MiniMax-M2.7', base: 'https://api.minimaxi.com/v1', key: secrets.minimax.apiKey, model: 'MiniMax-M2.7' },
  { name: 'minimax @ minimax.io MiniMax-M3', base: 'https://api.minimax.io/v1', key: secrets.minimax.apiKey, model: 'MiniMax-M3' },
];

async function probeModels(base, key, ua) {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...(ua ? { 'User-Agent': ua } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await res.text()).slice(0, 400);
    return { status: res.status, body: text };
  } catch (e) {
    return { status: 'ERR', body: String(e?.message ?? e) };
  }
}

async function probeChat({ base, key, model, ua }) {
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...(ua ? { 'User-Agent': ua } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_completion_tokens: 512,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let content = '';
    try {
      const j = JSON.parse(text);
      content = j?.choices?.[0]?.message?.content ?? j?.error?.message ?? j?.base_resp?.status_msg ?? '';
    } catch { content = text.slice(0, 300); }
    return { status: res.status, content: String(content).slice(0, 200) };
  } catch (e) {
    return { status: 'ERR', content: String(e?.message ?? e) };
  }
}

const seenModelBases = new Set();
for (const c of combos) {
  const tag = `${c.base} ${c.ua === CLAUDE_UA ? '[claude-UA]' : c.ua === KIMI_CLI_UA ? '[kimi-UA]' : ''}`;
  if (!seenModelBases.has(tag + c.key.slice(0, 12))) {
    seenModelBases.add(tag + c.key.slice(0, 12));
    const m = await probeModels(c.base, c.key, c.ua);
    console.log(`\n[GET /models] ${tag}\n  → ${m.status} ${m.body.replace(/\s+/g, ' ').slice(0, 350)}`);
  }
  const r = await probeChat(c);
  const mark = r.status === 200 ? '✅' : '❌';
  console.log(`${mark} [chat] ${c.name}\n  → ${r.status} ${r.content.replace(/\s+/g, ' ')}`);
}
