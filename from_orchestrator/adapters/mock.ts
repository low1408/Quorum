import type { BrowserContext, Page } from 'playwright';
import type { BrowserAdapter, HealthStatus, AnomalyType } from './base.ts';

export class MockAdapter implements BrowserAdapter {
  providerId = 'mock';
  type = 'browser' as const;
  baseUrl = 'https://mock-provider.com';

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true };
  }

  async initSession(context: BrowserContext): Promise<void> {}

  async dispatchPrompt(page: Page, prompt: string, options?: { pasteOnly?: boolean }): Promise<void> {}

  async dispatchMultiSegmentPrompt(page: Page, segments: string[]): Promise<string> {
    return `Mocked response for multi-segment prompt with ${segments.length} segments.`;
  }

  async awaitNetworkCompletion(page: Page): Promise<void> {}

  async extractAndNormalizeAST(page: Page): Promise<string> {
    return "Mocked response text.";
  }

  async detectAnomaly(page: Page, error?: Error): Promise<AnomalyType> {
    return 'NONE';
  }

  async isInputReady(page: Page): Promise<boolean> {
    return true;
  }
}
