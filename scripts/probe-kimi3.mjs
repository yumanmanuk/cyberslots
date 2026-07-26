/** Probe #3 — widen the kimi endpoint search (platform.kimi.ai is a distinct
 *  service from the old Moonshot platform; the key may live on a different host). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { kimi } = JSON.parse(readFileSync(join(ROOT, '.dev', 'secrets.json'), 'utf8'));
const key = kimi.apiKey;

const hosts = [
  'https://api.moonshot.ai/v1',
  'https://api.moonshot.cn/v1',
  'https://api.kimi.ai/v1',
  'https://api.platform.kimi.ai/v1',
  'https://platform.kimi.ai/api/v1',
  'https://api.kimi.com/v1',
  'https://api.kimi.com/coding/v1',
];

async function getModels(base) {
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 220);
    return `${res.status} ${body}`;
  } catch (e) {
    return `ERR ${e?.cause?.code ?? e?.message ?? e}`;
  }
}

for (const h of hosts) {
  const r = await getModels(h);
  const ok = r.startsWith('200');
  console.log(`${ok ? '✅' : '❌'} GET ${h}/models\n   ${r}`);
}
