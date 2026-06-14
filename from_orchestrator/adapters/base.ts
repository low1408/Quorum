import type { BrowserContext, Page } from 'playwright';

export interface HealthStatus {
  healthy: boolean;
  message?: string;
}

export type AnomalyType = 'NONE' | 'CAPTCHA' | 'AUTH_EXPIRED' | 'RATE_LIMITED' | 'UNKNOWN';

export interface BaseAdapter {
  providerId: string;
  type: 'api' | 'browser';
  healthCheck(): Promise<HealthStatus>;
}

export interface BrowserAdapter extends BaseAdapter {
  baseUrl: string;

  /**
   * Initialize a new or existing browser session context (e.g. inject cookies/headers/viewports)
   */
  initSession(context: BrowserContext): Promise<void>;

  /**
   * Type prompt into input and trigger generation
   */
  dispatchPrompt(page: Page, prompt: string, options?: { pasteOnly?: boolean }): Promise<void>;

  /**
   * Dispatch multiple prompt segments sequentially into the same chat thread.
   * Each segment is sent as a separate message, awaiting completion before sending the next.
   * Only the final response is returned. This avoids text box character limits.
   */
  dispatchMultiSegmentPrompt(page: Page, segments: string[]): Promise<string>;

  /**
   * Monitor WebSocket, Server-Sent Events (SSE), or network patterns to resolve EXACTLY when streaming ends.
   */
  awaitNetworkCompletion(page: Page): Promise<void>;

  /**
   * Extract the DOM of the target page and normalize complex structures to unified Markdown
   */
  extractAndNormalizeAST(page: Page): Promise<string>;

  /**
   * Checks DOM / page status to detect anomalies like Captchas, rate limits, logins
   */
  detectAnomaly(page: Page, error?: Error): Promise<AnomalyType>;

  /**
   * Verifies if the provider's active text field is fully visible and ready for interaction.
   */
  isInputReady(page: Page): Promise<boolean>;
}
