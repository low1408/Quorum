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

export function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  constructor(entries: Iterable<readonly [string, ProviderFactory]> = []) {
    for (const [providerId, factory] of entries) {
      this.register(providerId, factory);
    }
  }

  register(providerId: string, factory: ProviderFactory, options: { replace?: boolean } = {}): this {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) throw new Error('Provider ID must be non-empty.');
    if (typeof factory !== 'function') throw new Error(`Provider factory for ${normalized} must be a function.`);
    if (this.factories.has(normalized) && !options.replace) {
      throw new Error(`Provider is already registered: ${normalized}`);
    }
    this.factories.set(normalized, factory);
    return this;
  }

  has(providerId: string): boolean {
    return this.factories.has(normalizeProviderId(providerId));
  }

  ids(): string[] {
    return Array.from(this.factories.keys()).sort();
  }

  create(providerId: string): BrowserAdapter {
    const normalized = normalizeProviderId(providerId);
    const factory = this.factories.get(normalized);
    if (!factory) {
      throw new Error(`Unsupported provider: ${providerId}. Supported providers: ${this.ids().join(', ')}`);
    }
    return factory();
  }

  validate(providers: string[], label = 'providers'): string[] {
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

    const unsupported = normalized.filter(provider => !this.has(provider));
    if (unsupported.length > 0) {
      throw new Error(`Unsupported provider IDs: ${unsupported.join(', ')}. Supported providers: ${this.ids().join(', ')}`);
    }

    return normalized;
  }
}

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
export function createDefaultProviderRegistry(options: { includeInternal?: boolean } = {}): ProviderRegistry {
  const includeInternal = options.includeInternal
    ?? (process.env.ENABLE_MOCK_PROVIDER === '1' || process.env.NODE_ENV === 'test');
  const entries = Object.entries({
    ...PUBLIC_PROVIDER_FACTORIES,
    ...(includeInternal ? INTERNAL_PROVIDER_FACTORIES : {})
  });
  return new ProviderRegistry(entries);
}

export const defaultProviderRegistry = createDefaultProviderRegistry();

export function isSupportedProvider(providerId: string): boolean {
  return defaultProviderRegistry.has(providerId);
}

export function createAdapter(providerId: string): BrowserAdapter {
  return defaultProviderRegistry.create(providerId);
}

export function validateProviderList(providers: string[], label = 'providers'): string[] {
  return defaultProviderRegistry.validate(providers, label);
}
