import type { Page } from 'playwright';
import { BaseBrowserAdapter } from './baseBrowser.ts';

/**
 * Xiaomi MiMo-specific browser automation adapter.
 */
export class MiMoAdapter extends BaseBrowserAdapter {
  public providerId = 'mimo';
  public baseUrl = 'https://aistudio.xiaomimimo.com';

  // MiMo has a very constrained effective context window (~8K tokens).
  // 6,000 chars is the safe ceiling inferred from repeated truncation failures.
  public override maxPromptChars: number = 6_000;

  protected textareaSelector = 'textarea, div[contenteditable="true"]';
  protected sendSelector = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送"]',
    'button[type="submit"]',
    'button.send-button',
    '[data-testid*="send" i]',
    'button:has(svg)',
  ].join(', ');
  protected stopSelector = [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
    'button.stop-button',
    '[data-testid*="stop" i]',
    '[class*="stop" i]',
    '[class*="generating" i]',
    '[class*="loading" i]',
  ].join(', ');
  protected markdownSelector = [
    '.markdown',
    '.prose',
    '[class*="markdown" i]',
    '[class*="prose" i]',
    '[class*="assistant" i]',
    '[class*="answer" i]',
    '[class*="message" i]',
  ].join(', ');

  private readonly responseCandidateSelector = [
    '.markdown',
    '.prose',
    '[class*="markdown" i]',
    '[class*="prose" i]',
    '[class*="assistant" i]',
    '[class*="answer" i]',
    '[class*="message" i]',
  ].join(', ');

  constructor() {
    super();
  }

  /**
   * Override dispatchPrompt to capture the count of response nodes BEFORE
   * the prompt is clicked, ensuring a reliable starting index for extraction.
   */
  public override async dispatchPrompt(page: Page, prompt: string, options?: { pasteOnly?: boolean }): Promise<void> {
    const snapshot = await this.getVisibleResponseSnapshot(page);
    this._lastResponseStartIndex = Math.max(0, snapshot.count);
    console.log(`[MIMO] Captured pre-dispatch response count: ${this._lastResponseStartIndex}`);

    // MiMo has many visible SVG-only buttons before the composer control
    // (sidebar, history actions, prompt suggestions). Reuse the shared input
    // path, then submit through a MiMo-specific composer button resolver.
    await super.dispatchPrompt(page, prompt, { pasteOnly: true, suppressPasteOnlyLog: true });

    if (options?.pasteOnly) {
      return;
    }

    let clicked = false;
    for (let i = 0; i < 24; i++) {
      clicked = await this.clickComposerSendControl(page);
      if (clicked) {
        console.log('[MIMO] Clicked composer send control.');
        return;
      }

      await page.waitForTimeout(250);
    }

    if (!clicked) {
      const anomaly = await this.detectAnomaly(page);
      if (anomaly !== 'NONE') {
        throw new Error(`Prompt dispatch blocked by anomaly: ${anomaly}`);
      }

      const textarea = page.locator(this.textareaSelector).first();
      await textarea.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => undefined);
      await page.waitForTimeout(300);
      await textarea.press('Enter');
    }
  }

  private async clickComposerSendControl(page: Page): Promise<boolean> {
    return await page.evaluate((editorSelector) => {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.pointerEvents !== 'none'
          && rect.width > 0
          && rect.height > 0
          && rect.bottom >= 0
          && rect.right >= 0
          && rect.top <= viewportHeight
          && rect.left <= viewportWidth;
      };

      const isEnabled = (el: HTMLElement): boolean => {
        const className = typeof el.className === 'string' ? el.className : '';
        const ariaDisabled = el.getAttribute('aria-disabled');
        return !(el as HTMLButtonElement).disabled
          && ariaDisabled !== 'true'
          && !/\bdisabled\b/i.test(className)
          && !/\bdisable\b/i.test(className);
      };

      const isNoisyControl = (el: HTMLElement): boolean => {
        const combined = [
          el.innerText,
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('data-testid'),
          el.className,
        ].filter(Boolean).join(' ').toLowerCase();

        return combined.includes('sidebar')
          || combined.includes('new conversation')
          || combined.includes('more actions')
          || combined.includes('dismiss')
          || combined.includes('api service')
          || combined.includes('free trial')
          || combined.includes('mimo claw')
          || combined.includes('mimo chat')
          || combined.includes('history');
      };

      const editors = (Array.from(document.querySelectorAll(editorSelector)) as HTMLElement[])
        .filter(isVisible);
      const editorRects = editors.map((el) => el.getBoundingClientRect());

      const scoreButton = (button: HTMLElement): number => {
        const rect = button.getBoundingClientRect();
        const className = typeof button.className === 'string' ? button.className.toLowerCase() : '';
        const label = (button.getAttribute('aria-label') || '').toLowerCase();
        const text = (button.innerText || button.textContent || '').trim();

        let score = 0;

        if (label.includes('send') || label.includes('发送')) score += 200;
        if (button.matches('button[type="submit"], [data-testid*="send" i], .send-button')) score += 180;
        if (className.includes('rounded-full')) score += 70;
        if (className.includes('bg-black') || className.includes('dark:bg-white')) score += 90;
        if (text.length === 0) score += 25;

        // MiMo's actual submit button is the rightmost composer control in the
        // lower half of the viewport. This avoids prompt suggestions and nav.
        if (rect.left > viewportWidth * 0.45) score += 35;
        if (rect.top > viewportHeight * 0.45) score += 35;
        score += rect.left / Math.max(1, viewportWidth);
        score += rect.top / Math.max(1, viewportHeight);

        if (editorRects.length > 0) {
          const bestDistance = Math.min(...editorRects.map((editorRect) => {
            const dx = Math.max(0, editorRect.left - rect.right, rect.left - editorRect.right);
            const dy = Math.max(0, editorRect.top - rect.bottom, rect.top - editorRect.bottom);
            return Math.hypot(dx, dy);
          }));

          if (bestDistance < 160) score += 80;
          if (bestDistance < 80) score += 80;
        }

        if (rect.width < 18 || rect.height < 18) score -= 80;
        if (text.length > 0) score -= Math.min(120, text.length * 4);
        if (isNoisyControl(button)) score -= 500;

        return score;
      };

      const candidates = (Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[])
        .filter((el) => isVisible(el) && isEnabled(el) && !isNoisyControl(el))
        .map((el) => ({ el, score: scoreButton(el) }))
        .filter(({ score }) => score > 100)
        .sort((a, b) => b.score - a.score);

      const target = candidates[0]?.el;
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
    }, this.textareaSelector).catch(() => false);
  }

  /**
   * MiMo's visible button set is noisy and can include sidebar/history controls.
   * Wait on response text growth instead of the shared "send button restored"
   * shortcut, with stop/loading selectors only used as supporting signals.
   */
  public override async awaitNetworkCompletion(page: Page): Promise<void> {
    const initialSnapshot = await this.getVisibleResponseSnapshot(page);
    if (this._lastResponseStartIndex < 0) {
      this._lastResponseStartIndex = Math.max(0, initialSnapshot.count);
    }

    let lastText = '';
    let stableCount = 0;
    let sawNewResponse = false;
    let sawStopControl = false;
    let stopGoneStableCount = 0;

    for (let i = 0; i < 180; i++) {
      const snapshot = await this.getVisibleResponseSnapshot(page);
      const stopActive = await this.isStopActive(page);
      const text = snapshot.text;
      const hasNewNode = snapshot.count > initialSnapshot.count;
      const hasChangedLastNode = initialSnapshot.lastText.length > 0 && snapshot.lastText !== initialSnapshot.lastText;
      const hasMeaningfulText = text.trim().length > 0;

      if (stopActive && !sawStopControl) {
        sawStopControl = true;
        sawNewResponse = true;
        console.log(`[STREAMING] ${this.providerId.toUpperCase()} stop/loading control appeared.`);
      }

      if (!sawNewResponse && hasMeaningfulText && (hasNewNode || hasChangedLastNode)) {
        sawNewResponse = true;
        console.log(`[STREAMING] ${this.providerId.toUpperCase()} response appeared.`);
      }

      if (sawNewResponse) {
        if (sawStopControl) {
          if (!stopActive && hasMeaningfulText) {
            stopGoneStableCount++;
            if (stopGoneStableCount >= 2) {
              console.log(`[STREAMING] ${this.providerId.toUpperCase()} completed (stop/loading control cleared).`);
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

  private async isStopActive(page: Page): Promise<boolean> {
    return await page.evaluate((selector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const isSidebarOrHistory = (el: HTMLElement): boolean => {
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        return text.includes('history')
          || text.includes('new conversation')
          || label.includes('sidebar')
          || label.includes('new conversation')
          || label.includes('more actions');
      };

      return (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .some((el) => isVisible(el) && !isSidebarOrHistory(el));
    }, this.stopSelector).catch(() => false);
  }

  private async getVisibleResponseSnapshot(page: Page): Promise<{ count: number; text: string; lastText: string }> {
    return await page.evaluate((selector) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const isNonResponseContent = (el: HTMLElement): boolean => {
        const combined = [
          el.className,
          el.getAttribute('data-testid'),
          el.getAttribute('role'),
          el.getAttribute('aria-label'),
          el.innerText,
        ].filter(Boolean).join(' ').toLowerCase();

        return el.closest('[contenteditable="true"], textarea, input, nav, aside') !== null
          || combined.includes('history')
          || combined.includes('new conversation')
          || combined.includes('mimo claw')
          || combined.includes('mimo chat')
          || combined.includes('more actions')
          || /\buser\b/.test(combined)
          || combined.includes('prompt');
      };

      const nodes = (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .filter((el) => isVisible(el) && !isNonResponseContent(el));

      // Filter to keep only the outermost elements
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
    }, this.responseCandidateSelector).catch(() => ({ count: 0, text: '', lastText: '' }));
  }

  /**
   * Custom extraction pipeline for MiMo to only retrieve actual assistant response nodes
   * using high-fidelity visibility and content filters.
   */
  public override async extractAndNormalizeAST(page: Page): Promise<string> {
    const responseStartIndex = this._lastResponseStartIndex;

    const markdownOutput = await page.evaluate(({ selector, startIdx }) => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const isNonResponseContent = (el: HTMLElement): boolean => {
        const combined = [
          el.className,
          el.getAttribute('data-testid'),
          el.getAttribute('role'),
          el.getAttribute('aria-label'),
          el.innerText,
        ].filter(Boolean).join(' ').toLowerCase();

        return el.closest('[contenteditable="true"], textarea, input, nav, aside') !== null
          || combined.includes('history')
          || combined.includes('new conversation')
          || combined.includes('mimo claw')
          || combined.includes('mimo chat')
          || combined.includes('more actions')
          || /\buser\b/.test(combined)
          || combined.includes('prompt');
      };

      const nodes = (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .filter((el) => isVisible(el) && !isNonResponseContent(el));

      // Filter to keep only the outermost elements
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

      if (outermostNodes.length === 0) return '';

      let targetNodes: HTMLElement[] = [];
      if (startIdx >= 0 && startIdx < outermostNodes.length) {
        for (let i = startIdx; i < outermostNodes.length; i++) {
          targetNodes.push(outermostNodes[i]);
        }
      } else {
        // Fallback: just use the last node
        targetNodes = [outermostNodes[outermostNodes.length - 1]];
      }

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
          case 'CODE':
            const isCodeBlock = el.parentElement?.tagName.toUpperCase() === 'PRE';
            if (isCodeBlock) return parseChildren(el);
            return `\`${parseChildren(el)}\``;
          case 'PRE':
            const codeEl = el.querySelector('code');
            const lang = codeEl?.className.replace(/language-/, '') || '';
            const codeText = codeEl ? codeEl.innerText : el.innerText;
            return `\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n`;
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

      return targetNodes.map(node => parseNode(node)).join('\n');
    }, { selector: this.responseCandidateSelector, startIdx: responseStartIndex });

    // Reset start index to ensure clean state
    this._lastResponseStartIndex = -1;

    return markdownOutput.trim();
  }

  private async logCompletionDiagnostics(page: Page): Promise<void> {
    const diagnostics = await page.evaluate(({ responseSelector, stopSelector }) => {
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

      const controls = Array.from(new Set([
        ...Array.from(document.querySelectorAll('button, [role="button"], [aria-label]')),
        ...Array.from(document.querySelectorAll(stopSelector)),
      ]))
        .filter((el) => isVisible(el as HTMLElement))
        .map(summarize)
        .slice(0, 40);

      const responses = (Array.from(document.querySelectorAll(responseSelector)) as HTMLElement[])
        .filter(isVisible)
        .map(summarize)
        .slice(-20);

      return {
        url: location.href,
        title: document.title,
        activeElement: document.activeElement ? summarize(document.activeElement) : null,
        controls,
        responses,
      };
    }, {
      responseSelector: this.responseCandidateSelector,
      stopSelector: this.stopSelector,
    }).catch((error: Error) => ({ error: error.message }));

    console.log(`[MIMO][DIAGNOSTICS] ${JSON.stringify(diagnostics, null, 2)}`);
  }
}
