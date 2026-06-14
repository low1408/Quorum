import type { Page, BrowserContext, Response } from 'playwright';
import type { BrowserAdapter, AnomalyType, HealthStatus, BrowserOperationOptions } from './base.ts';
import { config } from '../config/index.ts';

/**
 * Premium, OOP-driven abstract class implementing shared browser automation
 * pipelines for Multi-LLM providers. Binds text-typing, stream waiting, and DOM parsing.
 */
export abstract class BaseBrowserAdapter implements BrowserAdapter {
  public abstract providerId: string;
  public abstract baseUrl: string;
  public type: 'api' | 'browser' = 'browser';

  // Core visual selector tokens to be defined by each provider implementation
  protected abstract textareaSelector: string;
  protected abstract sendSelector: string;
  protected abstract stopSelector: string;
  protected abstract markdownSelector: string;

  // Maximum characters allowed in a single prompt paste for this provider.
  // Prompts longer than this will be auto-split into acknowledged context-loading
  // chunks by runner.ts. Override in constrained adapters (e.g. Qwen, MiMo).
  public maxPromptChars: number = 80_000;

  // Optional network interception configuration
  protected conversationUrlPart?: string;
  protected activeConversationResponse: Promise<Response> | null = null;
  protected responseResolver: ((val: Response) => void) | null = null;

  // Tracks the DOM node index where the latest response starts.
  // Set by awaitNetworkCompletion, consumed by extractAndNormalizeAST.
  // This enables multi-node response extraction (e.g., DeepSeek renders
  // long responses across multiple .ds-markdown containers).
  protected _lastResponseStartIndex: number = -1;

  public async healthCheck(): Promise<HealthStatus> {
    const missingSelectors = [
      ['textareaSelector', this.textareaSelector],
      ['sendSelector', this.sendSelector],
      ['stopSelector', this.stopSelector],
      ['markdownSelector', this.markdownSelector]
    ].filter(([, selector]) => !String(selector || '').trim());

    if (missingSelectors.length > 0) {
      return {
        healthy: false,
        message: `Missing selector configuration: ${missingSelectors.map(([name]) => name).join(', ')}`
      };
    }

    return { healthy: true, message: 'Selector configuration is present.' };
  }

  public async initSession(context: BrowserContext): Promise<void> {
    // Standard cookie injection hook if required (Playwright manages most state via context setup)
  }

  public async isInputReady(page: Page): Promise<boolean> {
    return await page.locator(this.textareaSelector).first().isVisible().catch(() => false);
  }

  /**
   * Captures the network conversation event before trigger to race streaming responses.
   */
  protected setupConversationListener(page: Page): void {
    if (!this.conversationUrlPart) return;

    this.activeConversationResponse = new Promise<Response>((resolve) => {
      this.responseResolver = resolve;
    });

    page.on('response', (response) => {
      if (response.url().includes(this.conversationUrlPart!) && response.request().method() === 'POST') {
        if (this.responseResolver) {
          this.responseResolver(response);
          this.responseResolver = null;
        }
      }
    });
  }

  /**
   * High-fidelity error-injected keystroke simulation aligning with Section 3 evasion biometrics.
   */
  protected async typeWithBiometrics(page: Page, text: string): Promise<void> {
    const QWERTY_NEIGHBORS: Record<string, string> = {
      a: 'qwsz', b: 'vghn', c: 'xdfv', d: 'ersfxc', e: 'wsdr', f: 'rtgvcd', g: 'tyhbvf', h: 'yujnbg',
      i: 'ujko', j: 'uikmnh', k: 'ijlm', l: 'okp', m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol',
      q: 'wa', r: 'edft', s: 'wedxza', t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc',
      y: 'tghu', z: 'asx',
      A: 'QWSZ', B: 'VGHN', C: 'XDFV', D: 'ERSFXC', E: 'WSDR', F: 'RTGVCD', G: 'TYHBVF', H: 'YUJNBG',
      I: 'UJKO', J: 'UIKMNH', K: 'IJLM', L: 'OKP', M: 'NJK', N: 'BHJM', O: 'IKLP', P: 'OL',
      Q: 'WA', R: 'EDFT', S: 'WEDXZA', T: 'RFGY', U: 'YHJI', V: 'CFGB', W: 'QASE', X: 'ZSDC',
      Y: 'TGHU', Z: 'ASX'
    };

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const randomRange = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

    // Filter/replace all newlines to prevent premature Enter key events in web chat textareas
    const sanitizedText = text.replace(/[\r\n]+/g, ' ');

    for (let i = 0; i < sanitizedText.length; i++) {
      const char = sanitizedText[i];
      const isAlphabetic = /[a-zA-Z]/.test(char);

      // Typo Evasion: 2% chance to type adjacent key on alphabetical character
      if (isAlphabetic && Math.random() < 0.02) {
        const neighbors = QWERTY_NEIGHBORS[char] || 'e';
        const typoChar = neighbors[Math.floor(Math.random() * neighbors.length)];

        await page.keyboard.type(typoChar);

        // Correction Sequence:
        // - Inject a 150ms-350ms delay upon error generation
        await delay(randomRange(150, 350));
        // - Issue an OS-level Backspace execution
        await page.keyboard.press('Backspace');
        // - Introduce a 100ms-250ms correction pause
        await delay(randomRange(100, 250));
        // - Input the true character value
        await page.keyboard.type(char);
      } else {
        await page.keyboard.type(char);
      }

      // Evasion Rules: Punctuation Boundaries & Keystroke Delay Variance
      if (['.', '?', '!'].includes(char)) {
        await delay(randomRange(400, 900));
      } else if ([',', ';'].includes(char)) {
        await delay(randomRange(200, 500));
      } else {
        await delay(randomRange(30, 80));
      }
    }
  }

  /**
   * Safe typing of prompt and clicking send button.
   */
  /**
   * Programmatically inserts text at the current cursor selection position
   * and fires the 'input' event to ensure framework virtual DOMs are synchronized.
   */
  protected async pasteTextAtCursor(page: Page, textarea: any, text: string): Promise<void> {
    await textarea.evaluate((el: any, val: string) => {
      el.focus();
      
      // 1. Try document.execCommand('insertText') first for flawless compatibility
      // with ProseMirror, TipTap, React, Vue, Svelte, and native browser undo histories.
      try {
        // Select all text first so we replace any existing contents cleanly
        const selection = window.getSelection();
        if (selection) {
          selection.selectAllChildren(el);
        }
        
        const success = document.execCommand('insertText', false, val);
        if (success) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      } catch (e) {
        // Fallback to manual manipulation if execCommand fails
      }
      
      // 2. Specific Fallback: Handle contenteditable div (e.g., Claude, Gemini, Kimi, Perplexity, Grok, MiniMax)
      if (el.tagName.toUpperCase() !== 'TEXTAREA' && (el.getAttribute('contenteditable') === 'true' || el.isContentEditable)) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
          el.textContent = val;
        } else {
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const textNode = document.createTextNode(val);
          range.insertNode(textNode);
          
          // Move caret to the end of the inserted node
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // 3. Specific Fallback: Handle standard textarea (e.g., ChatGPT, Deepseek, Qwen, Z.ai)
        const ta = el as HTMLTextAreaElement;
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        const originalValue = ta.value || '';
        const newValue = originalValue.substring(0, start) + val + originalValue.substring(end);
        
        // Retain standard React/Vue custom setter binding matching properties
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        
        if (valueSetter) {
          valueSetter.call(ta, newValue);
        } else if (prototypeValueSetter) {
          prototypeValueSetter.call(ta, newValue);
        } else {
          ta.value = newValue;
        }
        
        ta.selectionStart = ta.selectionEnd = start + val.length;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, text);
  }

  /**
   * Detects whether the provider's send control is actually clickable.
   * Some UIs render a visible control with a disabled class or aria-disabled state.
   */
  protected async isSendControlEnabled(sendButton: any): Promise<boolean> {
    try {
      return await sendButton.evaluate((el: HTMLElement) => {
        const disabledAttr = (el as HTMLButtonElement).disabled;
        const ariaDisabled = el.getAttribute('aria-disabled');
        const className = el.className || '';
        const pointerEvents = window.getComputedStyle(el).pointerEvents;

        if (disabledAttr) return false;
        if (ariaDisabled === 'true') return false;
        if (typeof className === 'string' && /\bdisabled\b/i.test(className)) return false;
        if (pointerEvents === 'none') return false;
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Safe typing of prompt and clicking send button.
   */
  public async dispatchPrompt(page: Page, prompt: string, options?: BrowserOperationOptions & { suppressPasteOnlyLog?: boolean }): Promise<void> {
    // Pre-setup network listener if active for this provider
    this.setupConversationListener(page);

    await page.waitForSelector(this.textareaSelector, { state: 'visible', timeout: 15000 });
    
    // Bring the tab to focus so the user can see and interact with it
    try {
      console.log(`[FOCUS] Bringing [${this.providerId.toUpperCase()}] tab to the front...`);
      await page.bringToFront();
    } catch (e: any) {
      console.warn(`[WARNING] Failed to bring page to front: ${e.message}`);
    }

    // Brief pause to allow manual adjustments if needed
    console.log(`[DELAY] Pausing for 0.5 seconds before dispatching...`);
    await page.waitForTimeout(500);

    // Focus the target input field
    const textarea = page.locator(this.textareaSelector).first();
    await textarea.click();
    await textarea.focus();

    if (config.humanTyping && prompt.length < 250) {
      console.log(`[BIOMETRICS] Typing prompt with hybrid copy-paste for quotes...`);
      
      // Sanitize prompt: replace all newlines with spaces to prevent premature submission via keyboard Enter
      const sanitizedPrompt = prompt.replace(/[\r\n]+/g, ' ');
      
      // Smart Split: detect context wrapping vs debate history quotes
      let intro = sanitizedPrompt;
      let history = '';
      let outro = '';

      const historyHeader1 = 'Here is the debate history so far: ';
      const historyHeader2 = 'The debate has continued. Here are the arguments since your last turn: ';

      if (sanitizedPrompt.includes(historyHeader1)) {
        const parts = sanitizedPrompt.split(historyHeader1);
        intro = parts[0] + historyHeader1;
        
        const rest = parts[1];
        const outroIndex = rest.lastIndexOf(' Review');
        if (outroIndex !== -1) {
          history = rest.substring(0, outroIndex);
          outro = rest.substring(outroIndex);
        } else {
          history = rest;
        }
      } else if (sanitizedPrompt.includes(historyHeader2)) {
        const parts = sanitizedPrompt.split(historyHeader2);
        intro = parts[0] + historyHeader2;

        const rest = parts[1];
        const outroIndex = rest.lastIndexOf(' Review');
        if (outroIndex !== -1) {
          history = rest.substring(0, outroIndex);
          outro = rest.substring(outroIndex);
        } else {
          history = rest;
        }
      }

      // Type the intro instruction block
      await this.typeWithBiometrics(page, intro);

      // Programmatically paste the history/quotes block instantly
      if (history) {
        console.log(`[BIOMETRICS] Pasting quote block (${history.length} chars)...`);
        await this.pasteTextAtCursor(page, textarea, history);
      }

      // Type the final outro instruction block
      if (outro) {
        await this.typeWithBiometrics(page, outro);
      }

    } else {
      // Fast bypass: instantly copy and paste prompt text via native DOM evaluation
      console.log(`[PASTING] Pasting prompt instantly (${prompt.length} characters)...`);
      await this.pasteTextAtCursor(page, textarea, prompt);

      // SPA framework-aligned physical keystroke alignment sequence to force virtual DOM synchronization
      try {
        await textarea.focus();
        await page.keyboard.press('End');
        await page.keyboard.type(' ');
        await new Promise(resolve => setTimeout(resolve, 100));
        await page.keyboard.press('Backspace');
      } catch (e: any) {
        console.warn(`[WARNING] Failed to execute physical sync sequence: ${e.message}`);
      }
    }

    if (options?.pasteOnly) {
      if (!options.suppressPasteOnlyLog) {
        console.log(`[PASTE-ONLY] Paste complete. Skipping click/send.`);
      }
      return;
    }

    // Small delay before clicking send for realism
    await new Promise(resolve => setTimeout(resolve, 1000));

    const sendButton = page.locator(this.sendSelector).first();
    let clicked = false;

    for (let i = 0; i < 12; i++) {
      const isVisible = await sendButton.isVisible().catch(() => false);
      const isEnabled = isVisible && await this.isSendControlEnabled(sendButton);

      if (isEnabled) {
        await sendButton.click({ force: true });
        clicked = true;
        break;
      }

      await page.waitForTimeout(250);
    }

    if (!clicked) {
      const anomaly = await this.detectAnomaly(page);
      if (anomaly !== 'NONE') {
        throw new Error(`Prompt dispatch blocked by anomaly: ${anomaly}`);
      }

      try {
        await textarea.press('Enter');
      } catch {
        throw new Error(`Send control was not clickable for provider ${this.providerId}. Selector may have drifted: ${this.sendSelector}`);
      }
    }
  }

  /**
   * Dispatches multiple prompt segments sequentially into the same chat thread.
   * Each segment is sent as a separate message. The adapter waits for the LLM to
   * finish responding before sending the next segment. Only the final response
   * (after the last segment) is extracted and returned.
   *
   * This avoids text box character limits that silently truncate long concatenated
   * prompts — each model's output gets its own message boundary.
   */
  public async dispatchMultiSegmentPrompt(page: Page, segments: string[]): Promise<string> {
    if (segments.length === 0) {
      throw new Error('dispatchMultiSegmentPrompt called with zero segments.');
    }

    // If only one segment, fall through to the standard single-dispatch path
    if (segments.length === 1) {
      await this.dispatchPrompt(page, segments[0]);
      await this.awaitNetworkCompletion(page);
      return await this.extractAndNormalizeAST(page);
    }

    // Send all segments except the last as "context loading" messages.
    // Wait for each to complete before sending the next.
    for (let i = 0; i < segments.length - 1; i++) {
      console.log(`[MULTI-SEGMENT] 📤 Sending segment ${i + 1}/${segments.length} (${segments[i].length} chars)...`);
      await this.dispatchPrompt(page, segments[i]);
      await this.awaitNetworkCompletion(page);
      console.log(`[MULTI-SEGMENT] ✅ Segment ${i + 1}/${segments.length} acknowledged by model.`);

      // Brief cooldown between segments to let the UI settle
      await page.waitForTimeout(1500);
    }

    // Send the final segment (the synthesis instruction) and extract only its response
    const lastIdx = segments.length - 1;
    console.log(`[MULTI-SEGMENT] 📤 Sending FINAL segment ${lastIdx + 1}/${segments.length} (${segments[lastIdx].length} chars)...`);
    await this.dispatchPrompt(page, segments[lastIdx]);
    await this.awaitNetworkCompletion(page);
    console.log(`[MULTI-SEGMENT] ✅ Final segment complete. Extracting response...`);
    return await this.extractAndNormalizeAST(page);
  }

  /**
   * Races network stream response, DOM button states, and text length stability to determine completion.
   */
  public async awaitNetworkCompletion(page: Page, options: BrowserOperationOptions = {}): Promise<void> {
    let active = true;
    const firstTokenMs = options.firstTokenMs ?? 60_000;
    const outputStabilizationMs = options.outputStabilizationMs ?? 180_000;
    const startedAt = Date.now();
    const throwIfAborted = () => {
      if (options.signal?.aborted) {
        const err = new Error(options.signal.reason instanceof Error ? options.signal.reason.message : 'Operation cancelled.');
        err.name = 'AbortError';
        (err as any).code = 'CANCELLED';
        throw err;
      }
    };

    // Count existing completed messages to index only the new response block
    const expectedIndex = await page.evaluate((sel) => {
      return document.querySelectorAll(sel).length;
    }, this.markdownSelector).catch(() => 0);

    // Store for extractAndNormalizeAST to know where the response starts
    this._lastResponseStartIndex = expectedIndex;

    const domPromise = (async () => {
      let lastLength = 0;
      let stableCount = 0;
      let buttonStableCount = 0;
      let generationStarted = false;

      for (let i = 0; Date.now() - startedAt < outputStabilizationMs; i++) {
        throwIfAborted();
        if (!active) return;

        const isClosed = await page.evaluate(() => false).catch(() => true);
        if (isClosed) return;

        // 1. Query button visibility states to detect active streaming status instantly
        const stopVisible = await page.locator(this.stopSelector).first().isVisible().catch(() => false);
        const sendVisible = await page.locator(this.sendSelector).first().isVisible().catch(() => false);

        // 2. Extract TOTAL text across ALL new response nodes (not just the first one).
        //    DeepSeek and other models can render a single response across multiple
        //    .ds-markdown / .markdown containers. Monitoring only nodes[expectedIndex]
        //    would miss text growth in subsequent nodes.
        const textContent = await page.evaluate(({ sel, startIdx }) => {
          const nodes = document.querySelectorAll(sel);
          let totalText = '';
          for (let n = startIdx; n < nodes.length; n++) {
            totalText += (nodes[n] as HTMLElement).innerText || '';
          }
          return totalText;
        }, { sel: this.markdownSelector, startIdx: expectedIndex }).catch(() => '');

        // 3. Generation start detection:
        if (!generationStarted) {
          // If the Stop button is visible OR text content starts appearing, stream has started
          if (stopVisible || textContent.length > 0) {
            generationStarted = true;
            console.log(`[STREAMING] 🚀 ${this.providerId.toUpperCase()} response stream started!`);
          } else {
            if (Date.now() - startedAt > firstTokenMs) {
              throw new Error(`First token timed out after ${firstTokenMs}ms`);
            }
            if (i > 0 && i % 4 === 0) {
              console.log(`[STREAMING] 💤 Waiting for ${this.providerId.toUpperCase()} response stream...`);
            }
          }
        }

        // 4. Active stream monitoring & completion detection:
        if (generationStarted) {
          const hasResponseText = textContent.length > 0;
          const textChanged = textContent.length !== lastLength;

          // A. Button-state detection with DOM stability guard. Send can return
          // before long answers are fully rendered into markdown nodes.
          if (!stopVisible && sendVisible && hasResponseText && !textChanged) {
            buttonStableCount++;
            if (buttonStableCount >= 4) {
              console.log(`[STREAMING] ✅ ${this.providerId.toUpperCase()} completed (Send restored, response DOM stable).`);
              return;
            }
          } else {
            buttonStableCount = 0;
          }

          if (i > 0 && i % 4 === 0) {
            console.log(`[STREAMING] ⏳ ${this.providerId.toUpperCase()} is streaming text... (${textContent.length} chars)`);
          }

          // B. FALLBACK DETECTION: Text length stability check
          // Only trigger if the Stop button is NOT visible (meaning we might have missed button selectors).
          // If the Stop button IS visible, we know the model is still actively thinking/generating, so we ignore text stability.
          if (!stopVisible && hasResponseText && !textChanged) {
            stableCount++;
            // If the text stops growing for 4.0 seconds (8 polls of 500ms), consider it completed as a fallback
            if (stableCount >= 8) {
              console.log(`[STREAMING] ✅ ${this.providerId.toUpperCase()} stream stabilized and completed (Fallback).`);
              return;
            }
          } else {
            stableCount = 0;
            if (textContent.length !== lastLength) {
              lastLength = textContent.length;
            }
          }
        }

        await Promise.race([
          page.waitForTimeout(500),
          new Promise<void>((_, reject) => {
            if (!options.signal) return;
            const onAbort = () => {
              options.signal?.removeEventListener('abort', onAbort);
              const err = new Error(options.signal?.reason instanceof Error ? options.signal.reason.message : 'Operation cancelled.');
              err.name = 'AbortError';
              (err as any).code = 'CANCELLED';
              reject(err);
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
          })
        ]);
      }
    })();

    // The provider network request can finish before the rendered response has
    // fully committed to the DOM. Treat it as diagnostic signal only; extraction
    // must wait for DOM text/button stability or it can capture only the first
    // few tokens of long ChatGPT answers.
    const networkPromise = this.activeConversationResponse
      ? this.activeConversationResponse.then(async response => {
        await response.finished().catch(() => {});
        console.log(`[STREAMING] ${this.providerId.toUpperCase()} network stream finished; waiting for DOM stability before extraction.`);
      }).catch((err) => {
        console.log(`[STREAMING] Network tracker info: ${err.message}`);
      })
      : null;

    if (networkPromise) {
      void networkPromise;
    }

    try {
      await Promise.race([
        domPromise.catch((err) => {
          if (active) console.log(`[STREAMING] DOM tracker info: ${err.message}`);
          throw err;
        }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Generation timed out after ${outputStabilizationMs}ms`)), outputStabilizationMs))
      ]);
    } catch (err: any) {
      const anomaly = await this.detectAnomaly(page, err).catch(() => 'UNKNOWN');
      if (anomaly !== 'NONE') {
        throw new Error(`Generation blocked by anomaly: ${anomaly}`);
      }
      throw err;
    } finally {
      active = false;
      this.activeConversationResponse = null;
    }
  }

  /**
   * Generic, high-fidelity DOM to Markdown parser.
   */
  public async extractAndNormalizeAST(page: Page): Promise<string> {
    // List of candidate selectors, prioritizing the specific adapter's selector
    const selectors = [
      this.markdownSelector,
      '.markdown',
      '.prose',
      '.message-content',
      'div[class*="message-content"]',
      'div[class*="Message"]',
      '.conversation-turn',
    ];

    let activeSelector = '';
    
    // Check if any selector becomes visible
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      for (const sel of selectors) {
        if (!sel) continue;
        const count = await page.locator(sel).count().catch(() => 0);
        if (count > 0) {
          activeSelector = sel;
          break;
        }
      }
      if (activeSelector) break;
      await page.waitForTimeout(500);
    }

    if (!activeSelector) {
      const anomaly = await this.detectAnomaly(page).catch(() => 'UNKNOWN');
      if (anomaly !== 'NONE') {
        throw new Error(`Extraction blocked by anomaly: ${anomaly}`);
      }
      throw new Error(`Failed to locate any message container using selectors: ${selectors.filter(Boolean).join(', ')}`);
    }

    // Use the response start index tracked by awaitNetworkCompletion.
    // If not set (e.g., direct extraction call), fall back to last node.
    const responseStartIndex = this._lastResponseStartIndex;

    const markdownOutput = await page.evaluate(({ selector, startIdx }) => {
      const markdownNodes = document.querySelectorAll(selector);
      if (markdownNodes.length === 0) return '';

      // If we have a tracked start index, extract ALL nodes from that index onwards.
      // This handles models like DeepSeek that render a single response across
      // multiple DOM containers (e.g., thinking block + response sections).
      let targetNodes: HTMLElement[] = [];
      if (startIdx >= 0 && startIdx < markdownNodes.length) {
        for (let i = startIdx; i < markdownNodes.length; i++) {
          targetNodes.push(markdownNodes[i] as HTMLElement);
        }
      } else {
        // Fallback: just use the last node
        targetNodes = [markdownNodes[markdownNodes.length - 1] as HTMLElement];
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

      // Parse all target nodes and join their markdown output
      return targetNodes.map(node => parseNode(node)).join('\n');
    }, { selector: activeSelector, startIdx: responseStartIndex });

    return markdownOutput.trim();
  }

  /**
   * Checks for Cloudflare and verify human pages.
   */
  public async detectAnomaly(page: Page, error?: Error): Promise<AnomalyType> {
    const title = await page.title();
    const content = await page.content();

    if (title.includes('Cloudflare') || content.includes('cf-challenge') || content.includes('ray-id')) {
      return 'CAPTCHA';
    }

    if (content.includes('Verify you are human') || await page.locator('iframe[src*="cloudflare"]').first().isVisible()) {
      return 'CAPTCHA';
    }

    // Login state triggers
    const url = page.url();
    if (url.includes('/login') || url.includes('/auth') || content.includes('Log in') || content.includes('Sign up')) {
      return 'AUTH_EXPIRED';
    }

    const rateLimitPattern = /rate limit|too many requests|temporarily unavailable|try again later/i;
    const hasVisibleRateLimitBanner = await page.locator([
      '[role="alert"]',
      '[role="status"]',
      '[aria-live]',
      '[data-testid*="toast" i]',
      '[data-testid*="error" i]',
      '[class*="toast" i]',
      '[class*="alert" i]',
      '[class*="error" i]',
      '[class*="banner" i]'
    ].join(',')).filter({ hasText: rateLimitPattern }).first().isVisible().catch(() => false);

    if (hasVisibleRateLimitBanner) {
      return 'RATE_LIMITED';
    }

    const hasUsableInput = await page.locator('textarea, [contenteditable="true"], input[type="text"]').first().isVisible().catch(() => false);
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    if (!hasUsableInput && rateLimitPattern.test(bodyText)) {
      return 'RATE_LIMITED';
    }

    return 'NONE';
  }
}
