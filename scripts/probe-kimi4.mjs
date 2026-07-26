/** Probe #4 — byte-for-byte replica of ai-server's upstream request shape:
 *  HTTP/2, headers = {content-type, authorization, accept-encoding: identity},
 *  NO user-agent. Also variants to isolate which factor unlocks the key. */
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { kimi } = JSON.parse(readFileSync(join(ROOT, '.dev', 'secrets.json'), 'utf8'));

const ORIGIN = 'https://api.kimi.com';
const PATH = '/coding/v1/chat/completions';
const body = JSON.stringify({
  model: 'kimi-for-coding',
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  max_completion_tokens: 256,
  stream: false,
});

function h2Request(extraHeaders, label) {
  return new Promise((resolvePromise) => {
    const session = http2.connect(ORIGIN);
    session.on('error', (e) => resolvePromise(`${label}: SESSION ERR ${e.message}`));
    const req = session.request({
      ':method': 'POST',
      ':path': PATH,
      'content-type': 'application/json',
      authorization: 'Bearer ' + kimi.apiKey,
      'accept-encoding': 'identity',
      ...extraHeaders,
    });
    let status = 0;
    const chunks = [];
    req.on('response', (h) => (status = h[':status']));
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      session.close();
      const text = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 260);
      resolvePromise(`${label}: ${status} ${text}`);
    });
    req.on('error', (e) => {
      session.close();
      resolvePromise(`${label}: REQ ERR ${e.message}`);
    });
    req.setTimeout(45_000, () => {
      req.close();
      session.close();
      resolvePromise(`${label}: TIMEOUT`);
    });
    req.end(body);
  });
}

console.log(await h2Request({}, 'h2 no-UA (ai-server replica)'));
console.log(await h2Request({ 'user-agent': 'claude-cli/2.1.161 (external, cli)' }, 'h2 claude-UA'));
console.log(await h2Request({ 'user-agent': 'codex_cli_rs/0.145.0' }, 'h2 codex-UA'));
console.log(await h2Request({ 'user-agent': 'kimi-code-cli/0.29.1' }, 'h2 kimi-cli-UA'));
