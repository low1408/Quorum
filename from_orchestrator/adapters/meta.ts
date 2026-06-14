import type { Page } from 'playwright';
import type { AnomalyType } from './base.ts';
import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Meta AI-specific browser automation adapter.
 *
 * Meta AI uses a Lexical rich-text editor (div[role="textbox"][contenteditable="true"])
 * instead of a raw <textarea>. The hidden <textarea> in the DOM is an internal Lexical
 * implementation detail and is NOT interactable — it must not be targeted.
 */
export class MetaAIAdapter extends BaseBrowserAdapter {
  public providerId = 'meta';
  public baseUrl = 'https://www.meta.ai';

  // Lexical editor: the visible input is a div[role="textbox"], NOT the hidden <textarea>
  protected textareaSelector = 'div[role="textbox"][contenteditable="true"]';
  protected sendSelector = 'button[aria-label="Send"]';
  protected stopSelector = 'button[aria-label="Stop"]';
  protected markdownSelector = '.markdown-content, .markdown, .meta-message-content';

  constructor() {
    super();
    this.conversationUrlPart = '/api/chat';
  }

  /**
   * Dismisses the "Connect your apps to Meta AI" interstitial banner if present.
   * This floating card can occlude the chat input area and block click targets.
   */
  private async dismissInterstitials(page: Page): Promise<void> {
    try {
      // The close button (X) on the "Connect your apps" banner
      const closeButton = page.locator('button[aria-label="Close"], button[aria-label="Dismiss"]').first();
      if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await closeButton.click();
        console.log('[META] Dismissed interstitial banner.');
        await page.waitForTimeout(300);
      }
    } catch {
      // No interstitial present — continue silently
    }
  }

  /**
   * Lexical-compatible text insertion via synthetic clipboard paste event.
   *
   * Lexical editors maintain an internal EditorState tree — direct DOM manipulation
   * (textContent, innerHTML, insertNode) does NOT update this state, leaving the
   * send button disabled and the editor in an inconsistent state.
   *
   * Instead, we dispatch a synthetic 'paste' event with a DataTransfer object,
   * which Lexical's onPasteForRichText handler intercepts and processes natively.
   */
  protected override async pasteTextAtCursor(page: Page, textarea: any, text: string): Promise<void> {
    await textarea.evaluate((el: HTMLElement, val: string) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', val);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(pasteEvent);
    }, text);
  }

  /**
   * Overrides dispatchPrompt to dismiss any interstitial banners before interacting.
   */
  public override async dispatchPrompt(page: Page, prompt: string, options?: { pasteOnly?: boolean }): Promise<void> {
    await this.dismissInterstitials(page);
    return super.dispatchPrompt(page, prompt, options);
  }

  /**
   * Overrides anomaly detection to handle Meta AI login wall and guest limits.
   */
  public override async detectAnomaly(page: Page, error?: Error): Promise<AnomalyType> {
    const baseAnomaly = await super.detectAnomaly(page, error);
    if (baseAnomaly !== 'NONE') {
      return baseAnomaly;
    }

    const content = await page.content();
    const lowerContent = content.toLowerCase();

    // Check if the "Log in" / "Log In" button or modal text is present
    const hasLoginButton = await page.locator('button:has-text("Log in"), button:has-text("Log In")').first().isVisible().catch(() => false);
    
    if (
      hasLoginButton ||
      lowerContent.includes('get more from meta ai') ||
      lowerContent.includes('log in to chat')
    ) {
      return 'AUTH_EXPIRED';
    }

    // If the Lexical textbox is not visible, we may be on the unauthenticated landing page
    const isTextareaVisible = await page.locator(this.textareaSelector).first().isVisible().catch(() => false);
    if (!isTextareaVisible) {
      return 'AUTH_EXPIRED';
    }

    return 'NONE';
  }
}

