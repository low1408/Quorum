import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * ChatGPT specific browser automation adapter.
 */
export class ChatGPTAdapter extends BaseBrowserAdapter {
  public providerId = 'chatgpt';
  public baseUrl = 'https://chatgpt.com';

  protected textareaSelector = '#prompt-textarea';
  protected sendSelector = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
  protected stopSelector = 'button[data-testid="stop-button"], button[aria-label="Stop generating"]';
  protected markdownSelector = '.markdown';

  constructor() {
    super();
    // Enable network stream interception for ChatGPT
    this.conversationUrlPart = '/backend-api/conversation';
  }
}
