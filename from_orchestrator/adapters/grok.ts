import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Grok-specific browser automation adapter.
 */
export class GrokAdapter extends BaseBrowserAdapter {
  public providerId = 'grok';
  public baseUrl = 'https://grok.com';

  protected textareaSelector = 'div[contenteditable="true"].ProseMirror, textarea';
  protected sendSelector = 'button:has(svg), button[aria-label="Send"], button.send-button';
  protected stopSelector = 'button[aria-label*="Stop"], button.stop-button';
  protected markdownSelector = '.prose, .markdown';

  constructor() {
    super();
  }
}
