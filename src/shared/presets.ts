/**
 * Provider presets — cc-switch style: picking a preset pre-fills the
 * endpoint, wire protocol and a sensible default model; the user only
 * supplies the API key (and can tweak models afterwards).
 */

import type { ProviderProtocol } from './types';

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** Suggested models pre-filled when the preset is added. */
  models: Array<{ alias: string; model: string; maxContextSize: number }>;
  /** Extra headers required by the endpoint (e.g. UA allowlists). */
  customHeaders?: Record<string, string>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    baseUrl: 'https://api.kimi.com/coding/v1',
    protocol: 'openai_chat',
    models: [{ alias: 'kimi-for-coding', model: 'kimi-for-coding', maxContextSize: 262144 }],
  },
  {
    id: 'moonshot',
    name: 'Moonshot 开放平台',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai_chat',
    models: [{ alias: 'kimi-k2', model: 'kimi-k2-turbo-preview', maxContextSize: 262144 }],
  },
  {
    id: 'minimax',
    name: 'MiniMax（国内）',
    baseUrl: 'https://api.minimaxi.com/v1',
    protocol: 'openai_responses',
    models: [{ alias: 'MiniMax-M3', model: 'MiniMax-M3', maxContextSize: 204800 }],
  },
  {
    id: 'minimax-intl',
    name: 'MiniMax（国际）',
    baseUrl: 'https://api.minimax.io/v1',
    protocol: 'openai_responses',
    models: [{ alias: 'MiniMax-M3', model: 'MiniMax-M3', maxContextSize: 204800 }],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai_responses',
    models: [{ alias: 'gpt-5.2', model: 'gpt-5.2', maxContextSize: 400000 }],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai_chat',
    models: [{ alias: 'deepseek-chat', model: 'deepseek-chat', maxContextSize: 131072 }],
  },
];
