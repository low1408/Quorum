import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * MiniMax-specific browser automation adapter.
 */
export class MiniMaxAdapter extends BaseBrowserAdapter {
  public providerId = 'minimax';
  public baseUrl = 'https://agent.minimax.io';

  protected textareaSelector = '[data-testid="message-textarea"], .tiptap.ProseMirror, div[contenteditable="true"]';
  protected sendSelector = 'button[data-testid="send-button"], div[role="button"][data-testid="send-button"], [data-testid="send-button"]';
  protected stopSelector = 'button[data-testid="stop-button"], button.stop-button, button[aria-label*="Stop"]';
  protected markdownSelector = '.matrix-markdown.message-content, .markdown, .prose';

  constructor() {
    super();
  }
}
