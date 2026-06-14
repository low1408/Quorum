import type { Page } from 'playwright';
import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Z.ai-specific browser automation adapter.
 */
export class ZaiAdapter extends BaseBrowserAdapter {
  public providerId = 'z-ai';
  public baseUrl = 'https://chat.z.ai';

  protected textareaSelector = 'textarea#chat-input';
  protected sendSelector = 'button#send-message-button';
  protected stopSelector = [
    'button.stop-message-button',
    'button[aria-label*="Stop" i]',
    'button[title*="Stop" i]',
    '[data-testid*="stop" i]',
    '[class*="stop" i]',
  ].join(', ');
  protected markdownSelector = [
    '.chat-assistant.markdown-prose',
    '[class*="chat-assistant" i][class*="markdown-prose" i]',
    '[id^="message-"]:not(.user-message) .markdown-prose',
  ].join(', ');

  constructor() {
    super();
  }

  /**
   * Z-AI Deep Think can pause after rendering a short "Thought Process"
   * fragment before the final answer appears. The shared fallback only checks
   * text length stability, so it can finish on that pause. For Z-AI, require
   * the send control to be restored before accepting stability while Deep Think
   * is enabled.
   */
  public override async awaitNetworkCompletion(page: Page): Promise<void> {
    const initialSnapshot = await this.getVisibleResponseSnapshot(page);
    this._lastResponseStartIndex = Math.max(0, initialSnapshot.count);

    const deepThinkEnabled = await this.isDeepThinkEnabled(page);
    let lastText = '';
    let stableCount = 0;
    let sendRestoredStableCount = 0;
    let sawNewResponse = false;

    for (let i = 0; i < 360; i++) {
      const snapshot = await this.getVisibleResponseSnapshot(page);
      const stopActive = await this.isStopActive(page);
      const sendRestored = await this.isSendRestored(page);
      const text = snapshot.text;
      const hasMeaningfulText = text.trim().length > 0;
      const hasNewNode = snapshot.count > initialSnapshot.count;
      const hasChangedLastNode = snapshot.lastText.length > 0 && snapshot.lastText !== initialSnapshot.lastText;
      const textChanged = text !== lastText;

      if (!sawNewResponse && (stopActive || (hasMeaningfulText && (hasNewNode || hasChangedLastNode)))) {
        sawNewResponse = true;
        console.log(`[STREAMING] 🚀 ${this.providerId.toUpperCase()} response stream started!`);
      }

      if (sawNewResponse) {
        if (i > 0 && i % 4 === 0) {
          console.log(`[STREAMING] ⏳ ${this.providerId.toUpperCase()} is streaming text... (${text.length} chars)`);
        }

        if (!stopActive && sendRestored && hasMeaningfulText && !textChanged) {
          sendRestoredStableCount++;
          const requiredStablePolls = deepThinkEnabled ? 6 : 4;
          if (sendRestoredStableCount >= requiredStablePolls) {
            console.log(`[STREAMING] ✅ ${this.providerId.toUpperCase()} completed (Send restored, response DOM stable).`);
            return;
          }
        } else {
          sendRestoredStableCount = 0;
        }

        if (!deepThinkEnabled && !stopActive && hasMeaningfulText && !textChanged) {
          stableCount++;
          if (stableCount >= 8) {
            console.log(`[STREAMING] ✅ ${this.providerId.toUpperCase()} stream stabilized and completed (Fallback).`);
            return;
          }
        } else {
          stableCount = 0;
        }

        if (textChanged) {
          lastText = text;
        }
      } else if (i > 0 && i % 4 === 0) {
        console.log(`[STREAMING] 💤 Waiting for ${this.providerId.toUpperCase()} response stream...`);
      }

      await page.waitForTimeout(500);
    }

    const anomaly = await this.detectAnomaly(page).catch(() => 'UNKNOWN');
    if (anomaly !== 'NONE') {
      throw new Error(`Generation blocked by anomaly: ${anomaly}`);
    }

    throw new Error('Generation timed out after 180 seconds');
  }

  private async isDeepThinkEnabled(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const nodes = Array.from(document.querySelectorAll('button, [aria-label], [data-auto-think], [data-autoThink]')) as HTMLElement[];
      return nodes.some((el) => {
        if (!isVisible(el)) return false;

        const labelText = [
          el.innerText,
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
        ].filter(Boolean).join(' ').toLowerCase();

        const attributeText = [
          el.getAttribute('data-auto-think'),
          el.getAttribute('data-autoThink'),
          el.getAttribute('data-active'),
        ].filter(Boolean).join(' ').toLowerCase();

        return labelText.includes('deep think enabled')
          || attributeText.includes('autothink=true')
          || attributeText.includes('auto-think=true')
          || attributeText === 'true';
      });
    }).catch(() => false);
  }

  private async isStopActive(page: Page): Promise<boolean> {
    return await page.evaluate((selector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      return (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .some((el) => isVisible(el));
    }, this.stopSelector).catch(() => false);
  }

  private async isSendRestored(page: Page): Promise<boolean> {
    return await page.evaluate((selector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const button = document.querySelector(selector) as HTMLButtonElement | null;
      return Boolean(button && isVisible(button));
    }, this.sendSelector).catch(() => false);
  }

  private async getVisibleResponseSnapshot(page: Page): Promise<{ count: number; text: string; lastText: string }> {
    return await page.evaluate((selector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const nodes = (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .filter((el) => isVisible(el));

      const outermostNodes = nodes.filter((el) => {
        let parent = el.parentElement;
        while (parent) {
          if (nodes.includes(parent)) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      });

      const texts = outermostNodes
        .map((el) => (el.innerText || '').trim())
        .filter((text) => text.length > 0);

      return {
        count: outermostNodes.length,
        text: texts.join('\n\n'),
        lastText: texts[texts.length - 1] || '',
      };
    }, this.markdownSelector).catch(() => ({ count: 0, text: '', lastText: '' }));
  }
}
