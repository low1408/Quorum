import type { Page } from 'playwright';
import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Kimi-specific browser automation adapter.
 */
export class KimiAdapter extends BaseBrowserAdapter {
  public providerId = 'kimi';
  public baseUrl = 'https://www.kimi.com';

  protected textareaSelector = '.chat-input-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]';
  protected sendSelector = [
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[type="submit"]',
    '[data-testid*="send"]',
    '.send-button:not(.disabled)',
    '.send-button-container:not(.disabled)',
    '[class*="send-button"]:not(.disabled)',
  ].join(', ');
  protected stopSelector = [
    '.send-button-container.stop',
    '[class*="send-button" i].stop',
    'button[aria-label*="Stop"]',
    'button.stop-button',
  ].join(', ');
  protected markdownSelector = [
    'main [class*="assistant" i]:not([class*="user" i]) .markdown',
    'main [class*="assistant" i]:not([class*="user" i]) .prose',
    'main [class*="assistant" i]:not([class*="user" i]) [class*="markdown" i]',
    'main article[class*="assistant" i]',
    'main [data-testid*="assistant" i]',
    'main [class*="assistant" i]:not([class*="user" i])',
    'main .markdown',
    'main .prose',
  ].join(', ');

  private readonly responseCandidateSelector = [
    'main article[class*="assistant" i]',
    'main [data-testid*="assistant" i]',
    'main [class*="assistant" i]:not([class*="user" i])',
    'main [class*="bot" i]:not([class*="button" i])',
    'main [class*="markdown" i]',
    'main .prose',
  ].join(', ');

  constructor() {
    super();
  }

  /**
   * Kimi uses a Lexical editor. Native DOM insertion and synthetic paste events
   * are unreliable here, so we use Playwright keyboard insertion after focus.
   */
  protected override async pasteTextAtCursor(page: Page, textarea: any, text: string): Promise<void> {
    await textarea.click();
    await textarea.focus();
    await page.keyboard.insertText(text);
  }

  /**
   * Kimi needs a stricter submit sequence than the generic browser adapter.
   * We wait for the Lexical editor to accept text, then click the visible
   * enabled send control using native pointer/mouse events.
   */
  public override async dispatchPrompt(page: Page, prompt: string, options?: { pasteOnly?: boolean }): Promise<void> {
    this.setupConversationListener(page);

    const textarea = page.locator(this.textareaSelector).first();
    await textarea.waitFor({ state: 'visible', timeout: 15000 });

    try {
      console.log(`[FOCUS] Bringing [${this.providerId.toUpperCase()}] tab to the front...`);
      await page.bringToFront();
    } catch (e: any) {
      console.warn(`[WARNING] Failed to bring page to front: ${e.message}`);
    }

    console.log(`[DELAY] Pausing for 0.5 seconds before dispatching...`);
    await page.waitForTimeout(500);

    await textarea.click();
    await textarea.focus();

    const normalizedPrompt = prompt.replace(/[\r\n]+/g, ' ');
    console.log(`[PASTING] Inserting KIMI prompt via keyboard (${normalizedPrompt.length} characters)...`);
    await this.pasteTextAtCursor(page, textarea, normalizedPrompt);

    // Give Lexical time to flush editor state before checking button enablement.
    await page.waitForTimeout(750);

    if (options?.pasteOnly) {
      console.log(`[PASTE-ONLY] Paste complete. Skipping click/send.`);
      return;
    }

    let clicked = false;

    for (let i = 0; i < 24; i++) {
      const didClick = await page.evaluate(() => {
        const isVisible = (el: HTMLElement): boolean => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.pointerEvents !== 'none'
            && rect.width > 0
            && rect.height > 0;
        };

        const isEnabled = (el: HTMLElement): boolean => {
          const className = typeof el.className === 'string' ? el.className : '';
          const ariaDisabled = el.getAttribute('aria-disabled');
          const disabledAttr = (el as HTMLButtonElement).disabled;
          return !disabledAttr && ariaDisabled !== 'true' && !/\bdisabled\b/i.test(className);
        };

        const selectors = [
          'button[aria-label*="Send"]',
          'button[aria-label*="发送"]',
          'button[type="submit"]',
          '[data-testid*="send" i]',
          '.send-button:not(.disabled)',
          '.send-button-container:not(.disabled)',
          '[class*="send-button" i]:not(.disabled)',
        ];

        const candidates = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)) as HTMLElement[])
          .filter((el, index, arr) => arr.indexOf(el) === index)
          .filter((el) => isVisible(el) && isEnabled(el));

        candidates.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const aScore = ar.top + ar.left + (a.tagName === 'BUTTON' ? 1000 : 0);
          const bScore = br.top + br.left + (b.tagName === 'BUTTON' ? 1000 : 0);
          return bScore - aScore;
        });

        const target = candidates[0];
        if (!target) return false;

        target.scrollIntoView({ block: 'center', inline: 'center' });
        for (const eventType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(eventType, {
            bubbles: true,
            cancelable: true,
            view: window,
          }));
        }
        target.click();
        return true;
      }).catch(() => false);

      if (didClick) {
        console.log('[KIMI] Send control is enabled, clicking it directly...');
        clicked = true;
        break;
      }

      await page.waitForTimeout(250);
    }

    if (!clicked) {
      console.log('[KIMI] Send control did not enable in time, falling back to Ctrl+Enter then Enter.');
      await textarea.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => undefined);
      await page.waitForTimeout(500);
      await textarea.press('Enter');
    }
  }

  /**
   * Kimi currently does not expose a reliable streaming control in the same way
   * as most other providers. Avoid the shared "send button is visible again"
   * shortcut because it can fire before Kimi has rendered a new answer.
   */
  public override async awaitNetworkCompletion(page: Page): Promise<void> {
    const initialSnapshot = await this.getVisibleResponseSnapshot(page);
    this._lastResponseStartIndex = Math.max(0, initialSnapshot.count);

    let lastText = '';
    let stableCount = 0;
    let sawNewResponse = false;
    let sawStopControl = false;
    let stopGoneStableCount = 0;

    for (let i = 0; i < 180; i++) {
      const snapshot = await this.getVisibleResponseSnapshot(page);
      const stopActive = await this.isKimiStopActive(page);
      const text = snapshot.text;
      const hasNewNode = snapshot.count > initialSnapshot.count;
      const hasChangedLastNode = snapshot.lastText.length > 0 && snapshot.lastText !== initialSnapshot.lastText;
      const hasMeaningfulText = text.trim().length > 0;

      if (stopActive && !sawStopControl) {
        sawStopControl = true;
        sawNewResponse = true;
        console.log(`[STREAMING] ${this.providerId.toUpperCase()} stop control appeared.`);
      }

      if (!sawNewResponse && hasMeaningfulText && (hasNewNode || hasChangedLastNode)) {
        sawNewResponse = true;
        console.log(`[STREAMING] ${this.providerId.toUpperCase()} response appeared.`);
      }

      if (sawNewResponse) {
        if (sawStopControl) {
          if (!stopActive) {
            stopGoneStableCount++;
            if (stopGoneStableCount >= 2) {
              console.log(`[STREAMING] ${this.providerId.toUpperCase()} completed (stop control cleared).`);
              return;
            }
          } else {
            stopGoneStableCount = 0;
          }
        }

        if (!stopActive && text === lastText && hasMeaningfulText) {
          stableCount++;
          if (stableCount >= 8) {
            console.log(`[STREAMING] ${this.providerId.toUpperCase()} response stabilized.`);
            return;
          }
        } else {
          stableCount = 0;
          lastText = text;
        }
      } else if (i > 0 && i % 8 === 0) {
        console.log(`[STREAMING] Waiting for ${this.providerId.toUpperCase()} response to appear...`);
      }

      await page.waitForTimeout(500);
    }

    console.warn(`[STREAMING] ${this.providerId.toUpperCase()} completion wait timed out; extracting latest visible response candidate.`);
    await this.logCompletionDiagnostics(page);
  }

  private async isKimiStopActive(page: Page): Promise<boolean> {
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

  private async getVisibleResponseSnapshot(page: Page): Promise<{ count: number; text: string; lastText: string }> {
    return await page.evaluate((selector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const isInputOrUserContent = (el: HTMLElement): boolean => {
        const combined = [
          el.className,
          el.getAttribute('data-testid'),
          el.getAttribute('role'),
          el.getAttribute('aria-label'),
        ].filter(Boolean).join(' ').toLowerCase();

        return el.closest('[contenteditable="true"], textarea, input') !== null
          || /\buser\b/.test(combined)
          || combined.includes('chat-input')
          || combined.includes('prompt');
      };

      const nodes = (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .filter((el) => isVisible(el) && !isInputOrUserContent(el));

      const texts = nodes
        .map((el) => (el.innerText || '').trim())
        .filter((text) => text.length > 0);

      return {
        count: nodes.length,
        text: texts.join('\n\n'),
        lastText: texts[texts.length - 1] || '',
      };
    }, this.responseCandidateSelector).catch(() => ({ count: 0, text: '', lastText: '' }));
  }

  private async logCompletionDiagnostics(page: Page): Promise<void> {
    const diagnostics = await page.evaluate((responseSelector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const summarize = (el: Element) => {
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        return {
          tag: htmlEl.tagName,
          text: (htmlEl.innerText || htmlEl.textContent || '').trim().slice(0, 180),
          className: typeof htmlEl.className === 'string' ? htmlEl.className.slice(0, 180) : '',
          id: htmlEl.id || '',
          role: htmlEl.getAttribute('role') || '',
          ariaLabel: htmlEl.getAttribute('aria-label') || '',
          ariaDisabled: htmlEl.getAttribute('aria-disabled') || '',
          disabled: (htmlEl as HTMLButtonElement).disabled === true,
          dataTestId: htmlEl.getAttribute('data-testid') || '',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      };

      const buttonSelectors = [
        'button',
        '[role="button"]',
        '[aria-label]',
        '[class*="send" i]',
        '[class*="stop" i]',
        '[class*="generat" i]',
        '[class*="loading" i]',
      ];

      const buttons = Array.from(new Set(
        buttonSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      ))
        .filter((el) => isVisible(el as HTMLElement))
        .map(summarize)
        .slice(0, 30);

      const responses = (Array.from(document.querySelectorAll(responseSelector)) as HTMLElement[])
        .filter(isVisible)
        .map(summarize)
        .slice(-10);

      return {
        url: location.href,
        title: document.title,
        activeElement: document.activeElement ? summarize(document.activeElement) : null,
        buttons,
        responses,
      };
    }, this.responseCandidateSelector).catch((error: Error) => ({ error: error.message }));

    console.log(`[KIMI][DIAGNOSTICS] ${JSON.stringify(diagnostics, null, 2)}`);
  }

  /**
   * Kimi sometimes renders the assistant response in a non-standard message
   * container instead of the usual markdown wrapper. When the shared extractor
   * misses it, fall back to the newest visible assistant-like block and parse
   * it directly.
   */
  public override async extractAndNormalizeAST(page: Page): Promise<string> {
    const fallback = await page.evaluate(({ selector, startIdx }) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const isInputOrUserContent = (el: HTMLElement): boolean => {
        const combined = [
          el.className,
          el.getAttribute('data-testid'),
          el.getAttribute('role'),
          el.getAttribute('aria-label'),
        ].filter(Boolean).join(' ').toLowerCase();

        return el.closest('[contenteditable="true"], textarea, input') !== null
          || /\buser\b/.test(combined)
          || combined.includes('chat-input')
          || combined.includes('prompt');
      };

      function parseNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent || '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        const el = node as HTMLElement;
        const tagName = el.tagName.toUpperCase();

        switch (tagName) {
          case 'H1': return `\n# ${parseChildren(el)}\n`;
          case 'H2': return `\n## ${parseChildren(el)}\n`;
          case 'H3': return `\n### ${parseChildren(el)}\n`;
          case 'H4': return `\n#### ${parseChildren(el)}\n`;
          case 'P': return `\n${parseChildren(el)}\n`;
          case 'STRONG':
          case 'B': return `**${parseChildren(el)}**`;
          case 'EM':
          case 'I': return `*${parseChildren(el)}*`;
          case 'CODE': {
            const isCodeBlock = el.parentElement?.tagName.toUpperCase() === 'PRE';
            if (isCodeBlock) return parseChildren(el);
            return `\`${parseChildren(el)}\``;
          }
          case 'PRE': {
            const codeEl = el.querySelector('code');
            const lang = codeEl?.className.replace(/language-/, '') || '';
            const codeText = codeEl ? codeEl.innerText : el.innerText;
            return `\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n`;
          }
          case 'UL': return `\n${parseList(el, '*')}\n`;
          case 'OL': return `\n${parseList(el, '1.')}\n`;
          case 'LI': return parseChildren(el);
          case 'TABLE': return `\n${parseTable(el)}\n`;
          case 'A': return `[${parseChildren(el)}](${el.getAttribute('href') || ''})`;
          case 'BLOCKQUOTE': return `\n> ${parseChildren(el).replace(/\n/g, '\n> ')}\n`;
          case 'BR': return '\n';
          default: return parseChildren(el);
        }
      }

      function parseChildren(element: HTMLElement): string {
        let content = '';
        element.childNodes.forEach((child) => {
          content += parseNode(child);
        });
        return content;
      }

      function parseList(listElement: HTMLElement, bullet: string): string {
        let listMarkdown = '';
        let index = 1;
        listElement.childNodes.forEach((child) => {
          if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).tagName.toUpperCase() === 'LI') {
            const currentBullet = bullet === '1.' ? `${index++}.` : bullet;
            listMarkdown += `${currentBullet} ${parseChildren(child as HTMLElement).trim()}\n`;
          }
        });
        return listMarkdown;
      }

      function parseTable(tableElement: HTMLElement): string {
        let tableMarkdown = '';
        const rows = tableElement.querySelectorAll('tr');
        rows.forEach((row, rowIndex) => {
          let rowMarkdown = '|';
          const cells = row.querySelectorAll('th, td');
          cells.forEach((cell) => {
            rowMarkdown += ` ${parseChildren(cell as HTMLElement).trim()} |`;
          });
          tableMarkdown += `${rowMarkdown}\n`;

          if (rowIndex === 0) {
            let separator = '|';
            cells.forEach(() => { separator += ' --- |'; });
            tableMarkdown += `${separator}\n`;
          }
        });
        return tableMarkdown;
      }

      const visibleElements = (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .filter((el) => isVisible(el) && !isInputOrUserContent(el));

      const targetElements = startIdx >= 0 && startIdx < visibleElements.length
        ? visibleElements.slice(startIdx)
        : visibleElements.length > 0
          ? [visibleElements[visibleElements.length - 1]]
          : [];

      const parsed = targetElements
        .map((el) => {
          const markdown = parseNode(el).trim();
          return markdown.length > 0 ? markdown : (el.innerText || '').trim();
        })
        .filter((text) => text.length > 0)
        .join('\n\n')
        .trim();

      if (parsed.length > 0) {
        return parsed;
      }

      const broadSelectors = [
        'main article[class*="assistant" i]',
        'main [data-testid*="assistant" i]',
        'main [class*="assistant" i]:not([class*="user" i])',
        'main [class*="markdown" i]',
        'main .prose',
        '.markdown',
        '.prose',
      ];

      for (const broadSelector of broadSelectors) {
        const elements = (Array.from(document.querySelectorAll(broadSelector)) as HTMLElement[])
          .filter((el) => isVisible(el) && !isInputOrUserContent(el));
        const el = elements[elements.length - 1];
        if (!el) {
          continue;
        }
        const markdown = parseNode(el).trim();
        if (markdown.length > 0) {
          return markdown;
        }
        const text = (el.innerText || '').trim();
        if (text.length > 0) {
          return text;
        }
      }

      return '';
    }, { selector: this.responseCandidateSelector, startIdx: this._lastResponseStartIndex });

    if (fallback.trim().length > 0) {
      return fallback.trim();
    }

    try {
      const standard = await super.extractAndNormalizeAST(page);
      if (standard.trim().length > 0) {
        return standard;
      }
    } catch {
      // Keep the empty fallback if no generic selector works.
    }

    return fallback.trim();
  }
}
