import type { BrowserAdapter } from './base.ts';
import { ChatGPTAdapter } from './chatgpt.ts';
import { GeminiAdapter } from './gemini.ts';
import { ClaudeAdapter } from './claude.ts';
import { QwenAdapter } from './qwen.ts';
import { DeepseekAdapter } from './deepseek.ts';
import { MetaAIAdapter } from './meta.ts';
import { MiMoAdapter } from './mimo.ts';
import { MiniMaxAdapter } from './minimax.ts';
import { PerplexityAdapter } from './perplexity.ts';
import { KimiAdapter } from './kimi.ts';
import { GrokAdapter } from './grok.ts';
import { ZaiAdapter } from './zai.ts';
import { MockAdapter } from './mock.ts';

export type ProviderFactory = () => BrowserAdapter;

const PUBLIC_PROVIDER_FACTORIES = {
  chatgpt: () => new ChatGPTAdapter(),
  gemini: () => new GeminiAdapter(),
  claude: () => new ClaudeAdapter(),
  qwen: () => new QwenAdapter(),
  deepseek: () => new DeepseekAdapter(),
  meta: () => new MetaAIAdapter(),
  mimo: () => new MiMoAdapter(),
  minimax: () => new MiniMaxAdapter(),
  perplexity: () => new PerplexityAdapter(),
  kimi: () => new KimiAdapter(),
  grok: () => new GrokAdapter(),
  'z-ai': () => new ZaiAdapter()
} satisfies Record<string, ProviderFactory>;

const INTERNAL_PROVIDER_FACTORIES = {
  mock: () => new MockAdapter()
} satisfies Record<string, ProviderFactory>;

export const PUBLIC_PROVIDER_IDS = Object.keys(PUBLIC_PROVIDER_FACTORIES).sort();
export const INTERNAL_PROVIDER_IDS = Object.keys(INTERNAL_PROVIDER_FACTORIES).sort();
export const SUPPORTED_PROVIDER_IDS = [
  ...PUBLIC_PROVIDER_IDS,
  ...(process.env.ENABLE_MOCK_PROVIDER === '1' || process.env.NODE_ENV === 'test' ? INTERNAL_PROVIDER_IDS : [])
].sort();

export function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function providerFactories(): Record<string, ProviderFactory> {
  if (process.env.ENABLE_MOCK_PROVIDER === '1' || process.env.NODE_ENV === 'test') {
    return { ...PUBLIC_PROVIDER_FACTORIES, ...INTERNAL_PROVIDER_FACTORIES };
  }
  return PUBLIC_PROVIDER_FACTORIES;
}

export function isSupportedProvider(providerId: string): boolean {
  return normalizeProviderId(providerId) in providerFactories();
}

export function createAdapter(providerId: string): BrowserAdapter {
  const normalized = normalizeProviderId(providerId);
  const factory = providerFactories()[normalized];
  if (!factory) {
    throw new Error(`Unsupported provider: ${providerId}. Supported providers: ${SUPPORTED_PROVIDER_IDS.join(', ')}`);
  }
  return factory();
}

export function validateProviderList(providers: string[], label = 'providers'): string[] {
  if (providers.length === 0) {
    throw new Error(`At least one ${label} entry is required.`);
  }

  const normalized = providers.map(normalizeProviderId);
  if (normalized.some(provider => !provider)) {
    throw new Error(`${label} cannot contain empty provider IDs.`);
  }

  const duplicates = normalized.filter((provider, index) => normalized.indexOf(provider) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate provider IDs are not allowed after normalization: ${Array.from(new Set(duplicates)).join(', ')}`);
  }

  const unsupported = normalized.filter(provider => !isSupportedProvider(provider));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported provider IDs: ${unsupported.join(', ')}. Supported providers: ${SUPPORTED_PROVIDER_IDS.join(', ')}`);
  }

  return normalized;
}
