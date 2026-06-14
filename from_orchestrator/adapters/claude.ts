import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Claude-specific browser automation adapter.
 */
export class ClaudeAdapter extends BaseBrowserAdapter {
  public providerId = 'claude';
  public baseUrl = 'https://claude.ai';

  protected textareaSelector = 'div[contenteditable="true"], div[role="textbox"]';
  protected sendSelector = 'button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label*="Send"]';
  protected stopSelector = 'button[aria-label="Stop response"], button[aria-label="Stop Generating"], button[aria-label*="Stop"], button.stop-button';
  protected markdownSelector = '.font-claude-response, .font-claude-response-body, .font-claude-message, .claude-message-body, .markdown';

  constructor() {
    super();
    this.conversationUrlPart = '/api/organizations';
  }
}
