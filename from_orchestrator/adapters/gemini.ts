import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Gemini-specific browser automation adapter.
 */
export class GeminiAdapter extends BaseBrowserAdapter {
  public providerId = 'gemini';
  public baseUrl = 'https://gemini.google.com';

  protected textareaSelector = 'div[role="textbox"], div[contenteditable="true"]';
  protected sendSelector = 'button[aria-label="Send prompt"], button.send-button';
  protected stopSelector = 'button[aria-label="Stop generating"], button.stop-button';
  protected markdownSelector = 'message-content, .conversation-turn';

  constructor() {
    super();
    this.conversationUrlPart = '/rpc/ChatBidiService/ChatBidi';
  }
}
