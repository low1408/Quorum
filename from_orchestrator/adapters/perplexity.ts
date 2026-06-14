import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Perplexity-specific browser automation adapter.
 */
export class PerplexityAdapter extends BaseBrowserAdapter {
  public providerId = 'perplexity';
  public baseUrl = 'https://www.perplexity.ai';

  protected textareaSelector = '#ask-input, textarea';
  protected sendSelector = 'button[aria-label="Submit query"], button[aria-label="Send"], button:has(svg)';
  protected stopSelector = 'button[aria-label*="Stop"], button.stop-button';
  protected markdownSelector = '.markdown, .prose';

  constructor() {
    super();
  }
}
