import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserAdapter } from '../adapters/base.ts';
import { ChatGPTAdapter } from '../adapters/chatgpt.ts';
import { GeminiAdapter } from '../adapters/gemini.ts';
import { ClaudeAdapter } from '../adapters/claude.ts';
import { QwenAdapter } from '../adapters/qwen.ts';
import { DeepseekAdapter } from '../adapters/deepseek.ts';
import { MetaAIAdapter } from '../adapters/meta.ts';
import { MiMoAdapter } from '../adapters/mimo.ts';
import { MiniMaxAdapter } from '../adapters/minimax.ts';
import { PerplexityAdapter } from '../adapters/perplexity.ts';
import { KimiAdapter } from '../adapters/kimi.ts';
import { GrokAdapter } from '../adapters/grok.ts';
import { ZaiAdapter } from '../adapters/zai.ts';
import { MockAdapter } from '../adapters/mock.ts';
import { SessionManager } from '../security/sessionManager.ts';
import { DBService } from '../db/database.ts';
import { config } from '../config/index.ts';
import { splitPromptIntoChunks } from '../tools/promptChunker.ts';

// Add stealth plugin to playwright chromium extra
const chromiumExtra = chromium;
try {
  chromiumExtra.use(stealthPlugin());
} catch {
  // Ignore if already registered
}

export function getAdapter(providerId: string): BrowserAdapter {
  switch (providerId.toLowerCase()) {
    case 'chatgpt': return new ChatGPTAdapter();
    case 'gemini': return new GeminiAdapter();
    case 'claude': return new ClaudeAdapter();
    case 'qwen': return new QwenAdapter();
    case 'deepseek': return new DeepseekAdapter();
    case 'meta': return new MetaAIAdapter();
    case 'mimo': return new MiMoAdapter();
    case 'minimax': return new MiniMaxAdapter();
    case 'perplexity': return new PerplexityAdapter();
    case 'kimi': return new KimiAdapter();
    case 'grok': return new GrokAdapter();
    case 'z-ai': return new ZaiAdapter();
    case 'mock': return new MockAdapter();
    default:
      throw new Error(`Unsupported provider: ${providerId}`);
  }
}

export type OrchestrationState = 
  | 'IDLE' 
  | 'DISPATCHING' 
  | 'STREAMING' 
  | 'STABILIZING' 
  | 'EXTRACTING' 
  | 'INTERVENTION_REQUIRED'
  | 'COMPLETE' 
  | 'FAILED';

export class InterventionRequiredError extends Error {
  public code = 'INTERVENTION_REQUIRED';
  public failure_class: string;

  constructor(message: string, failureClass: string) {
    super(message);
    this.name = 'InterventionRequiredError';
    this.failure_class = failureClass;
  }
}

export interface SessionPoolItem {
  browser: any;
  context: any;
  page: any;
  hasActiveThread: boolean;
  isCdp?: boolean;
}

function getOSAlignedUserAgent(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  } else if (platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  } else {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  }
}

export class OrchestrationRunner {
  private adapter: BrowserAdapter;
  private taskId: string;
  private runId: string;
  private currentState: OrchestrationState = 'IDLE';
  private stateStartTime: number;
  private isCdpConnection: boolean = false;
  private manageRunStatus: boolean;

  constructor(
    runId: string,
    taskId: string,
    providerId: string = 'chatgpt',
    options: { manageRunStatus?: boolean } = {}
  ) {
    this.adapter = getAdapter(providerId);
    this.runId = runId;
    this.taskId = taskId;
    this.stateStartTime = Date.now();
    this.manageRunStatus = options.manageRunStatus ?? true;
  }

  /**
   * Safe state transition tracking with telemetry database logging
   */
  private transitionTo(nextState: OrchestrationState): void {
    const now = Date.now();
    const durationMs = now - this.stateStartTime;
    
    console.log(`[STATE] ${this.currentState} -> ${nextState} (took ${durationMs}ms)`);
    
    // Log telemetry to SQLite
    try {
      DBService.addTelemetry({
        taskId: this.taskId,
        stateFrom: this.currentState,
        stateTo: nextState,
        durationMs,
      });
    } catch (err: any) {
      console.error(`Telemetry logging failed: ${err.message}`);
    }

    this.currentState = nextState;
    this.stateStartTime = now;
  }

  private async persistExtractedResponse(
    markdown: string,
    extractionMethod: 'clean' | 'timeout_forced' | 'manual' | 'api'
  ): Promise<void> {
    DBService.updateTaskResponse({
      taskId: this.taskId,
      responseText: markdown,
      extractionMethod,
      status: 'COMPLETED',
    });
    if (this.manageRunStatus) {
      DBService.updateRunStatus(this.runId, 'COMPLETED');
    }
  }

  private async forceExtractAfterCompletionFailure(page: any, error: any): Promise<string | null> {
    console.warn(`[WARNING] Completion wait failed for ${this.taskId}: ${error?.message || String(error)}`);
    console.warn('[WARNING] Attempting forced extraction before failing the task...');

    try {
      this.transitionTo('EXTRACTING');
      const markdown = await this.adapter.extractAndNormalizeAST(page);
      if (!markdown || !markdown.trim()) {
        return null;
      }

      await this.persistExtractedResponse(markdown, 'timeout_forced');
      this.transitionTo('COMPLETE');
      return markdown;
    } catch (extractErr: any) {
      console.warn(`[WARNING] Forced extraction failed for ${this.taskId}: ${extractErr?.message || String(extractErr)}`);
      return null;
    }
  }

  /**
   * Executes a prompt task end-to-end through the state machine.
   */
  public async executeTask(prompt: string, poolItem?: SessionPoolItem, options?: { pasteOnly?: boolean }): Promise<string> {
    console.log(`Starting run: ${this.runId}, task: ${this.taskId}`);

    // Create DB entries
    DBService.createRun(this.runId, prompt.substring(0, 100));
    DBService.createTask({
      taskId: this.taskId,
      runId: this.runId,
      providerName: this.adapter.providerId,
      promptPayload: prompt,
      status: 'IN_PROGRESS',
    });

    if (this.adapter.providerId.toLowerCase() === 'mock') {
      this.transitionTo('DISPATCHING');
      this.transitionTo('STREAMING');
      this.transitionTo('STABILIZING');
      this.transitionTo('EXTRACTING');
      const response = `[Mock Response from ${this.adapter.providerId.toUpperCase()}] for prompt: "${prompt}"`;
      DBService.updateTaskResponse({
        taskId: this.taskId,
        responseText: response,
        extractionMethod: 'api',
        status: 'COMPLETED',
      });
      if (this.manageRunStatus) {
        DBService.updateRunStatus(this.runId, 'COMPLETED');
      }
      this.transitionTo('COMPLETE');
      return response;
    }

    this.stateStartTime = Date.now();
    let browser: any = null;
    let context: any = null;
    let page: any = null;

    try {
      if (poolItem && poolItem.browser) {
        browser = poolItem.browser;
        context = poolItem.context;
        this.isCdpConnection = !!poolItem.isCdp;
        
        let isPageValid = false;
        if (poolItem.page) {
          try {
            isPageValid = !poolItem.page.isClosed();
          } catch {
            isPageValid = false;
          }
        }

        if (isPageValid) {
          page = poolItem.page;
          console.log(`Reusing active persistent browser tab for [${this.adapter.providerId.toUpperCase()}]`);
        } else {
          console.log(`Persistent tab for [${this.adapter.providerId.toUpperCase()}] is closed/missing. Spawning a NEW tab...`);
          page = await context.newPage();
          poolItem.page = page;
          console.log(`Navigating to ${this.adapter.baseUrl}...`);
          await page.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded' });
        }
      } else {
        if (config.cdpEndpoint) {
          console.log(`Connecting to existing browser via CDP: ${config.cdpEndpoint}...`);
          try {
            browser = await chromiumExtra.connectOverCDP(config.cdpEndpoint, { timeout: 5000 });
            context = browser.contexts()[0];
            if (!context) {
              context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: getOSAlignedUserAgent(),
              });
            }
            page = await context.newPage();
            this.isCdpConnection = true;
          } catch (err: any) {
            console.warn(`\n⚠️ [CDP CONNECTION FAILED]: ${err.message}`);
            console.warn(`Please ensure Brave is running with '--remote-debugging-port=9222'.`);
            console.warn(`Falling back to launching a standalone headed browser...\n`);
            this.isCdpConnection = false;
          }
        }

        if (!this.isCdpConnection) {
          // 1. Launch Browser
          console.log('Launching browser context...');
          browser = await chromiumExtra.launch({
            headless: config.headless,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            ],
          });

          // 2. Load Session Memory decryption
          const storageState = await SessionManager.loadSession(this.adapter.providerId);
          
          context = await browser.newContext({
            storageState: storageState || undefined,
            viewport: { width: 1280, height: 800 },
            userAgent: getOSAlignedUserAgent(),
          });

          await this.adapter.initSession(context);
          
          page = await context.newPage();
        }
        
        // Navigate to ChatGPT
        console.log(`Navigating to ${this.adapter.baseUrl}...`);
        await page.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded' });

        if (poolItem) {
          poolItem.browser = browser;
          poolItem.context = context;
          poolItem.page = page;
          poolItem.hasActiveThread = false;
          poolItem.isCdp = this.isCdpConnection;
        }
      }

      // Anomaly / Session Check
      let anomaly = await this.adapter.detectAnomaly(page);
      if (anomaly === 'AUTH_EXPIRED') {
        this.transitionTo('INTERVENTION_REQUIRED');
        console.warn('------------------------------------------------------------');
        console.warn('CRITICAL: AUTHENTICATION EXPIRED OR LOGIN REQUIRED!');
        console.warn('Please complete the login manually in the opened headed browser.');
        console.warn('The Orchestrator will pause and wait for authentication...');
        console.warn('------------------------------------------------------------');

        // Poll until prompt-textarea is available (proving login success)
        let authenticated = false;
        const authTimeout = 5 * 60 * 1000; // 5 minutes timeout
        const startAuth = Date.now();

        while (Date.now() - startAuth < authTimeout) {
          try {
            const isTextareaPresent = await this.adapter.isInputReady(page);
            if (isTextareaPresent) {
              authenticated = true;
              break;
            }
          } catch {
            // Ignore evaluator errors while page is transitioning
          }
          await page.waitForTimeout(2000);
        }

        if (!authenticated) {
          throw new InterventionRequiredError('Authentication intervention timed out after 5 minutes.', 'auth_expiry');
        }

        // Save session immediately so next launches are fully automated
        if (!this.isCdpConnection) {
          console.log('Authentication successful! Extracting and encrypting storage state...');
          const newState = await context.storageState();
          await SessionManager.saveSession(this.adapter.providerId, newState);
          console.log('Session saved successfully.');
        } else {
          console.log('Authentication successful!');
        }
        anomaly = 'NONE';
      }

      if (anomaly !== 'NONE') {
        throw new InterventionRequiredError(`Execution blocked by anomaly: ${anomaly}`, anomaly === 'CAPTCHA' ? 'captcha_intervention' : 'provider_intervention');
      }

      // Auto-chunk oversized prompts for constrained providers (e.g. Qwen, MiMo).
      // If the prompt exceeds the adapter's per-message character budget, split it
      // into acknowledged context-loading chunks and route through the multi-segment
      // pipeline. The intermediate chunks carry a "do not reply" directive so the
      // model outputs only a brief acknowledgment token instead of a full response.
      // pasteOnly tasks are never chunked — the caller controls submission manually.
      const maxChars = (this.adapter as any).maxPromptChars as number ?? 80_000;
      if (!options?.pasteOnly && prompt.length > maxChars) {
        const chunks = splitPromptIntoChunks(prompt, maxChars, `${this.adapter.providerId} prompt`);
        console.log(`[CHUNKING] ✂️ Prompt (${prompt.length} chars) exceeds ${maxChars}-char limit for [${this.adapter.providerId.toUpperCase()}]. Splitting into ${chunks.length} chunks via multi-segment path...`);

        // Delegate to executeMultiSegmentTask which handles browser setup, anomaly
        // checks, segment dispatch, and DB persistence. We must close the browser
        // at the end of this re-entrant call since poolItem ownership stays with caller.
        return await this.adapter.dispatchMultiSegmentPrompt(page, chunks);
      }

      // Transition to Dispatching
      this.transitionTo('DISPATCHING');
      await this.adapter.dispatchPrompt(page, prompt, options);

      if (options?.pasteOnly) {
        // Pause and wait for manual user action
        console.log('\n============================================================');
        console.log('⚠️ [MANUAL INTERVENTION] Socratic Critic prompt has been pasted.');
        console.log('Please review, edit, or submit the prompt manually in the browser.');
        console.log('Once the model has finished responding, press ENTER in this terminal to continue...');
        console.log('============================================================\n');

        const rlInterface = (await import('readline')).createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        await new Promise<void>((resolve) => {
          rlInterface.question('Press ENTER when response is ready to extract...', () => {
            rlInterface.close();
            resolve();
          });
        });

        // Transition to Extracting
        this.transitionTo('EXTRACTING');
        const markdown = await this.adapter.extractAndNormalizeAST(page);
        
        if (!markdown) {
          const err = new Error('Extraction yielded empty markdown output.');
          (err as any).failure_class = 'empty_extraction';
          throw err;
        }

        // Save Response & transition to complete
        await this.persistExtractedResponse(markdown, 'clean');
        this.transitionTo('COMPLETE');

        // Update Session context with latest updates/cookies
        if (!this.isCdpConnection) {
          const finalState = await context.storageState();
          await SessionManager.saveSession(this.adapter.providerId, finalState);
        }

        return markdown;
      }

      // Transition to Streaming
      this.transitionTo('STREAMING');
      try {
        await this.adapter.awaitNetworkCompletion(page);
      } catch (completionErr: any) {
        const forcedMarkdown = await this.forceExtractAfterCompletionFailure(page, completionErr);
        if (forcedMarkdown) {
          if (!this.isCdpConnection) {
            const finalState = await context.storageState();
            await SessionManager.saveSession(this.adapter.providerId, finalState);
          }
          return forcedMarkdown;
        }
        throw completionErr;
      }

      // Transition to Stabilizing (Mutation observer style delay)
      this.transitionTo('STABILIZING');
      // Wait 500ms of absolute silence for content layout stabilization
      await page.waitForTimeout(500);

      // Transition to Extracting
      this.transitionTo('EXTRACTING');
      const markdown = await this.adapter.extractAndNormalizeAST(page);
      
      if (!markdown) {
        const err = new Error('Extraction yielded empty markdown output.');
        (err as any).failure_class = 'empty_extraction';
        throw err;
      }

      // Save Response & transition to complete
      await this.persistExtractedResponse(markdown, 'clean');
      this.transitionTo('COMPLETE');

      // Update Session context with latest updates/cookies
      if (!this.isCdpConnection) {
        const finalState = await context.storageState();
        await SessionManager.saveSession(this.adapter.providerId, finalState);
      }

      return markdown;
    } catch (error: any) {
      console.error(`Task execution failed: ${error.message}`);
      
      DBService.updateTaskStatus(this.taskId, 'FAILED');
      if (this.manageRunStatus) {
        DBService.updateRunStatus(this.runId, 'FAILED');
      }
      this.transitionTo('FAILED');
      
      throw error;
    } finally {
      // Only close context and browser if not in active keep-alive pooling mode
      if (!poolItem) {
        if (this.isCdpConnection) {
          if (page) await page.close().catch(() => {});
        } else {
          if (context) await context.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
        }
      }
    }
  }

  /**
   * Executes a multi-segment prompt task. Instead of concatenating all model outputs
   * into a single giant string (which overflows the text box), each segment is sent
   * as a separate message in the same chat thread. Only the final response is extracted.
   *
   * This solves the truncation problem where contenteditable divs silently clip
   * long text beyond their internal character buffer.
   */
  public async executeMultiSegmentTask(segments: string[], poolItem?: SessionPoolItem): Promise<string> {
    console.log(`Starting multi-segment run: ${this.runId}, task: ${this.taskId}, segments: ${segments.length}`);

    // Create DB entries with the first segment as the prompt preview
    DBService.createRun(this.runId, segments[0]?.substring(0, 100) || '');
    DBService.createTask({
      taskId: this.taskId,
      runId: this.runId,
      providerName: this.adapter.providerId,
      promptPayload: segments.map((s, i) => `[Segment ${i + 1}]: ${s.substring(0, 200)}`).join('\n'),
      status: 'IN_PROGRESS',
    });

    if (this.adapter.providerId.toLowerCase() === 'mock') {
      this.transitionTo('DISPATCHING');
      this.transitionTo('COMPLETE');
      const response = `[Mock Response from ${this.adapter.providerId.toUpperCase()}] for multi-segment prompt: "${segments.join(' | ')}"`;
      DBService.updateTaskResponse({
        taskId: this.taskId,
        responseText: response,
        extractionMethod: 'api',
        status: 'COMPLETED',
      });
      if (this.manageRunStatus) {
        DBService.updateRunStatus(this.runId, 'COMPLETED');
      }
      return response;
    }

    this.stateStartTime = Date.now();
    let browser: any = null;
    let context: any = null;
    let page: any = null;

    try {
      // Browser/context/page setup is identical to executeTask
      if (poolItem && poolItem.browser) {
        browser = poolItem.browser;
        context = poolItem.context;
        this.isCdpConnection = !!poolItem.isCdp;
        
        let isPageValid = false;
        if (poolItem.page) {
          try {
            isPageValid = !poolItem.page.isClosed();
          } catch {
            isPageValid = false;
          }
        }

        if (isPageValid) {
          page = poolItem.page;
          console.log(`Reusing active persistent browser tab for [${this.adapter.providerId.toUpperCase()}]`);
        } else {
          console.log(`Persistent tab for [${this.adapter.providerId.toUpperCase()}] is closed/missing. Spawning a NEW tab...`);
          page = await context.newPage();
          poolItem.page = page;
          console.log(`Navigating to ${this.adapter.baseUrl}...`);
          await page.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded' });
        }
      } else {
        if (config.cdpEndpoint) {
          console.log(`Connecting to existing browser via CDP: ${config.cdpEndpoint}...`);
          try {
            browser = await chromiumExtra.connectOverCDP(config.cdpEndpoint, { timeout: 5000 });
            context = browser.contexts()[0];
            if (!context) {
              context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: getOSAlignedUserAgent(),
              });
            }
            page = await context.newPage();
            this.isCdpConnection = true;
          } catch (err: any) {
            console.warn(`\n⚠️ [CDP CONNECTION FAILED]: ${err.message}`);
            console.warn(`Please ensure Brave is running with '--remote-debugging-port=9222'.`);
            console.warn(`Falling back to launching a standalone headed browser...\n`);
            this.isCdpConnection = false;
          }
        }

        if (!this.isCdpConnection) {
          console.log('Launching browser context...');
          browser = await chromiumExtra.launch({
            headless: config.headless,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            ],
          });

          const storageState = await SessionManager.loadSession(this.adapter.providerId);
          
          context = await browser.newContext({
            storageState: storageState || undefined,
            viewport: { width: 1280, height: 800 },
            userAgent: getOSAlignedUserAgent(),
          });

          await this.adapter.initSession(context);
          page = await context.newPage();
        }
        
        console.log(`Navigating to ${this.adapter.baseUrl}...`);
        await page.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded' });

        if (poolItem) {
          poolItem.browser = browser;
          poolItem.context = context;
          poolItem.page = page;
          poolItem.hasActiveThread = false;
          poolItem.isCdp = this.isCdpConnection;
        }
      }

      // Anomaly / Session Check (same as executeTask)
      let anomaly = await this.adapter.detectAnomaly(page);
      if (anomaly === 'AUTH_EXPIRED') {
        this.transitionTo('INTERVENTION_REQUIRED');
        console.warn('------------------------------------------------------------');
        console.warn('CRITICAL: AUTHENTICATION EXPIRED OR LOGIN REQUIRED!');
        console.warn('Please complete the login manually in the opened headed browser.');
        console.warn('The Orchestrator will pause and wait for authentication...');
        console.warn('------------------------------------------------------------');

        let authenticated = false;
        const authTimeout = 5 * 60 * 1000;
        const startAuth = Date.now();

        while (Date.now() - startAuth < authTimeout) {
          try {
            const isTextareaPresent = await this.adapter.isInputReady(page);
            if (isTextareaPresent) {
              authenticated = true;
              break;
            }
          } catch {
            // Ignore evaluator errors while page is transitioning
          }
          await page.waitForTimeout(2000);
        }

        if (!authenticated) {
          throw new InterventionRequiredError('Authentication intervention timed out after 5 minutes.', 'auth_expiry');
        }

        if (!this.isCdpConnection) {
          console.log('Authentication successful! Extracting and encrypting storage state...');
          const newState = await context.storageState();
          await SessionManager.saveSession(this.adapter.providerId, newState);
          console.log('Session saved successfully.');
        } else {
          console.log('Authentication successful!');
        }
        anomaly = 'NONE';
      }

      if (anomaly !== 'NONE') {
        throw new InterventionRequiredError(`Execution blocked by anomaly: ${anomaly}`, anomaly === 'CAPTCHA' ? 'captcha_intervention' : 'provider_intervention');
      }

      // Multi-segment dispatch: each segment is its own message in the thread
      this.transitionTo('DISPATCHING');
      const markdown = await this.adapter.dispatchMultiSegmentPrompt(page, segments);
      this.transitionTo('COMPLETE');

      if (!markdown) {
        const err = new Error('Multi-segment extraction yielded empty markdown output.');
        (err as any).failure_class = 'empty_extraction';
        throw err;
      }

      // Save Response
      await this.persistExtractedResponse(markdown, 'clean');

      // Update Session
      if (!this.isCdpConnection) {
        const finalState = await context.storageState();
        await SessionManager.saveSession(this.adapter.providerId, finalState);
      }

      return markdown;
    } catch (error: any) {
      console.error(`Multi-segment task execution failed: ${error.message}`);
      
      DBService.updateTaskStatus(this.taskId, 'FAILED');
      if (this.manageRunStatus) {
        DBService.updateRunStatus(this.runId, 'FAILED');
      }
      this.transitionTo('FAILED');
      
      throw error;
    } finally {
      if (!poolItem) {
        if (this.isCdpConnection) {
          if (page) await page.close().catch(() => {});
        } else {
          if (context) await context.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
        }
      }
    }
  }
}
