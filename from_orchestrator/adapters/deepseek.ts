import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Deepseek-specific browser automation adapter.
 */
export class DeepseekAdapter extends BaseBrowserAdapter {
  public providerId = 'deepseek';
  public baseUrl = 'https://chat.deepseek.com';

  protected textareaSelector = 'textarea#chat-input, textarea';
  protected sendSelector = 'div[role="button"][aria-label="Send"], div[role="button"][aria-label="发送"], button.send-button, button[aria-label*="Send"], button[aria-label*="send"], div[role="button"] svg[class*="send"]';
  protected stopSelector = 'div[role="button"][aria-label="Stop"], div[role="button"][aria-label="停止"], button.stop-button, button[aria-label*="Stop"], button[aria-label*="stop"], div[role="button"] svg[class*="stop"]';
  protected markdownSelector = '.ds-markdown, .markdown, .deepseek-message-content';

  constructor() {
    super();
    this.conversationUrlPart = '/api/v1/chat';
  }
}
