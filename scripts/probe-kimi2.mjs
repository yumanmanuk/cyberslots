/** Probe #2 — kimi key: Anthropic-style auth (x-api-key) + remaining endpoint faces. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { kimi } = JSON.parse(readFileSync(join(ROOT, '.dev', 'secrets.json'), 'utf8'));
const UA = 'claude-cli/2.1.161 (external, cli)';

async function hit(name, url, headers, body) {
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 260);
    console.log(`${res.status === 200 ? '✅' : '❌'} ${name}\n  → ${res.status} ${text}`);
  } catch (e) {
    console.log(`❌ ${name}\n  → ERR ${e?.message ?? e}`);
  }
}

const anthropicBody = {
  model: 'kimi-for-coding',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
};
const chatBody = (model) => ({
  model,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  max_completion_tokens: 256,
});

await hit('coding /messages x-api-key', 'https://api.kimi.com/coding/v1/messages',
  { 'x-api-key': kimi.apiKey, 'anthropic-version': '2023-06-01' }, anthropicBody);
await hit('coding /messages Bearer', 'https://api.kimi.com/coding/v1/messages',
  { Authorization: `Bearer ${kimi.apiKey}`, 'anthropic-version': '2023-06-01' }, anthropicBody);
await hit('api.kimi.com/v1 chat kimi-k3', 'https://api.kimi.com/v1/chat/completions',
  { Authorization: `Bearer ${kimi.apiKey}` }, chatBody('kimi-k3'));
await hit('api.kimi.com/v1 chat kimi-for-coding', 'https://api.kimi.com/v1/chat/completions',
  { Authorization: `Bearer ${kimi.apiKey}` }, chatBody('kimi-for-coding'));
await hit('platform api.kimi.ai/v1 chat kimi-k3', 'https://api.kimi.ai/v1/chat/completions',
  { Authorization: `Bearer ${kimi.apiKey}` }, chatBody('kimi-k3'));
await hit('coding /chat/completions kimi-for-coding claude-UA', 'https://api.kimi.com/coding/v1/chat/completions',
  { Authorization: `Bearer ${kimi.apiKey}` }, chatBody('kimi-for-coding'));
