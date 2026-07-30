/**
 * AI 会话标题生成 — 调用用户在设置里配置的 OpenAI 兼容接口
 * （baseUrl / apiKey / model），从首条用户消息概括一个短标题。
 * key 只在主进程使用；任何失败（未配置 / 网络 / 超时 / 格式异常）
 * 一律返回 null，由渲染层回退到截取式标题，绝不阻塞发送链路。
 */

import type { TitleGenSettings } from '@shared/types';

const TIMEOUT_MS = 15_000;
/** 标题最长字符数 — 与截取式标题上限一致，超长强截。 */
const MAX_LEN = 24;

export async function generateTitle(cfg: TitleGenSettings, text: string): Promise<string | null> {
  const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
  const model = cfg.model.trim();
  if (cfg.mode !== 'ai' || !baseUrl || !model) return null;
  const input = text.trim().slice(0, 2000); // 长粘贴截断，标题只需要开头语义
  if (!input) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model,
        // 标题是确定性小任务：低温防跑题。max_tokens 不能给太小 —
        // 推理模型的思考段也计入配额，60 会被思考吃光导致 content 为空
        // （igw-common-agent 实测）。
        temperature: 0.2,
        max_tokens: 512,
        messages: [
          {
            role: 'system',
            content:
              '你是会话标题生成器。根据用户消息生成一个简短标题概括其意图，' +
              '不超过12个字（英文不超过6个单词），与消息同语言，' +
              '不要标点、引号、句号或任何解释，只输出标题本身。',
          },
          { role: 'user', content: input },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[titleGen] ${baseUrl} → HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? '';
    // 清洗：去 think 段（部分推理模型会带）、引号、换行，只留首行。
    const title = raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/["'“”‘’「」《》]/g, '')
      .trim()
      .split('\n')[0]!
      .trim()
      .slice(0, MAX_LEN);
    return title || null;
  } catch (err) {
    console.warn('[titleGen] failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
