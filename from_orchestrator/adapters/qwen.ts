import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Qwen-specific browser automation adapter.
 */
export class QwenAdapter extends BaseBrowserAdapter {
  public providerId = 'qwen';
  public baseUrl = 'https://chat.qwen.ai';

  // Qwen web UI has a stricter per-message paste limit than its API context window.
  // 20,000 chars (~5K tokens) is a safe ceiling observed in practice.
  public override maxPromptChars: number = 20_000;

  protected textareaSelector = 'textarea, div[contenteditable="true"]';
  protected sendSelector = 'button[aria-label="Send"], button.send-button';
  protected stopSelector = 'button[aria-label="Stop"], button.stop-button';
  protected markdownSelector = '.qwen-markdown, .response-message-content, .markdown, .prose, .message-content';

  constructor() {
    super();
    this.conversationUrlPart = '/api/chat';
  }
}
