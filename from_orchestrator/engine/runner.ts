import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { BrowserAdapter } from '../adapters/base.ts';
import { createAdapter } from '../adapters/registry.ts';
import { SessionManager } from '../security/sessionManager.ts';
import { DBService } from '../db/database.ts';
import { config } from '../config/index.ts';
import { splitPromptIntoChunks } from '../tools/promptChunker.ts';
import { abortableDelay, abortableRace, createCancelledError, isAbortError, throwIfAborted } from './statuses.ts';
import { closeSessionItem, type SessionPoolItem } from './providerSessionPool.ts';
import { DomainError, classifyFailure } from './failures.ts';

// Add stealth plugin to playwright chromium extra
const chromiumExtra = chromium;
try {
  chromiumExtra.use(stealthPlugin());
} catch {
  // Ignore if already registered
}

export const getAdapter = createAdapter;

export type OrchestrationState = 
  | 'IDLE' 
  | 'DISPATCHING' 
  | 'STREAMING' 
  | 'STABILIZING' 
  | 'EXTRACTING' 
  | 'INTERVENTION_REQUIRED'
  | 'COMPLETE' 
  | 'FAILED'
  | 'CANCELLED';

export class InterventionRequiredError extends Error {
  public code = 'INTERVENTION_REQUIRED';
  public failure_class: string;

  constructor(message: string, failureClass: string) {
    super(message);
    this.name = 'InterventionRequiredError';
    this.failure_class = failureClass;
  }
}

export type { SessionPoolItem } from './providerSessionPool.ts';

export interface RunnerTimeoutBudgets {
  navigationMs: number;
  inputReadyMs: number;
  submissionMs: number;
  firstTokenMs: number;
  outputStabilizationMs: number;
  providerExecutionMs: number;
}

export type RunnerExecuteOptions = {
  pasteOnly?: boolean;
  signal?: AbortSignal;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  attemptNo?: number;
};

const DEFAULT_RUNNER_TIMEOUTS: RunnerTimeoutBudgets = {
  navigationMs: 30_000,
  inputReadyMs: 15_000,
  submissionMs: 30_000,
  firstTokenMs: 60_000,
  outputStabilizationMs: 180_000,
  providerExecutionMs: 6 * 60_000
};

function timeoutError(stage: string, ms: number): Error {
  return new DomainError({
    code: 'TIMEOUT',
    message: `${stage} timed out after ${ms}ms.`,
    stage
  });
}

async function withStageTimeout<T>(stage: string, ms: number, work: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(timeoutError(stage, ms)), ms);
    });
    return await abortableRace(Promise.race([work, timeoutPromise]), signal, `${stage} cancelled.`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  private currentResources: SessionPoolItem | null = null;
  private disposed = false;

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

  public async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.currentResources) {
      await closeSessionItem(this.currentResources, 'runner close');
      this.currentResources = null;
    }
  }

  public async dispose(): Promise<void> {
    await this.close();
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
      DBService.updateRunStatusIfNotTerminal(this.runId, 'COMPLETED');
    }
  }

  private async forceExtractAfterCompletionFailure(page: Page, error: any, signal?: AbortSignal): Promise<string | null> {
    console.warn(`[WARNING] Completion wait failed for ${this.taskId}: ${error?.message || String(error)}`);
    console.warn('[WARNING] Attempting forced extraction before failing the task...');

    try {
      this.transitionTo('EXTRACTING');
      const markdown = await abortableRace(this.adapter.extractAndNormalizeAST(page), signal, 'Forced extraction cancelled.');
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
  public async executeTask(prompt: string, poolItem?: SessionPoolItem, options: RunnerExecuteOptions = {}): Promise<string> {
    console.log(`Starting run: ${this.runId}, task: ${this.taskId}`);
    const timeouts = { ...DEFAULT_RUNNER_TIMEOUTS, ...(options.timeouts || {}) };
    const signal = options.signal;
    let submissionConfirmed = false;
    throwIfAborted(signal);

    const onAbort = () => {
      void this.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    DBService.createRun(this.runId, prompt.substring(0, 100));
    DBService.createTask({
      taskId: this.taskId,
      runId: this.runId,
      providerName: this.adapter.providerId,
      promptPayload: prompt,
      status: 'IN_PROGRESS',
      attemptNo: options.attemptNo ?? 1,
    });

    if (this.adapter.providerId.toLowerCase() === 'mock') {
      throwIfAborted(signal);
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
        DBService.updateRunStatusIfNotTerminal(this.runId, 'COMPLETED');
      }
      this.transitionTo('COMPLETE');
      signal?.removeEventListener('abort', onAbort);
      return response;
    }

    this.stateStartTime = Date.now();
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let ownsBrowser = false;
    let ownsContext = false;
    let ownsPage = false;

    try {
      throwIfAborted(signal);
      if (poolItem && poolItem.browser) {
        browser = poolItem.browser;
        context = poolItem.context;
        this.isCdpConnection = !!poolItem.isCdp;
        ownsBrowser = !!poolItem.ownsBrowser;
        ownsContext = !!poolItem.ownsContext;
        ownsPage = poolItem.ownsPage !== false;

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
          page = await abortableRace(context!.newPage(), signal, 'Page creation cancelled.');
          ownsPage = true;
          poolItem.page = page;
          poolItem.ownsPage = true;
          poolItem.hasActiveThread = false;
          console.log(`Navigating to ${this.adapter.baseUrl}...`);
          await withStageTimeout('navigation', timeouts.navigationMs, page.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded', timeout: timeouts.navigationMs }), signal);
        }
      } else {
        if (config.cdpEndpoint) {
          console.log(`Connecting to existing browser via CDP: ${config.cdpEndpoint}...`);
          try {
            browser = await abortableRace(chromiumExtra.connectOverCDP(config.cdpEndpoint, { timeout: 5000 }), signal, 'CDP connection cancelled.');
            context = browser.contexts()[0] || null;
            if (!context) {
              context = await abortableRace(browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: getOSAlignedUserAgent(),
              }), signal, 'Context creation cancelled.');
              ownsContext = true;
            }
            page = await abortableRace(context.newPage(), signal, 'Page creation cancelled.');
            ownsPage = true;
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
          browser = await abortableRace(chromiumExtra.launch({
            headless: config.headless,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            ],
          }), signal, 'Browser launch cancelled.');
          ownsBrowser = true;

          const storageState = await SessionManager.loadSession(this.adapter.providerId);

          context = await abortableRace(browser.newContext({
            storageState: storageState || undefined,
            viewport: { width: 1280, height: 800 },
            userAgent: getOSAlignedUserAgent(),
          }), signal, 'Context creation cancelled.');
          ownsContext = true;

          await abortableRace(this.adapter.initSession(context), signal, 'Session initialization cancelled.');
          page = await abortableRace(context.newPage(), signal, 'Page creation cancelled.');
          ownsPage = true;
        }

        console.log(`Navigating to ${this.adapter.baseUrl}...`);
        await withStageTimeout('navigation', timeouts.navigationMs, page!.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded', timeout: timeouts.navigationMs }), signal);

        if (poolItem) {
          poolItem.browser = browser;
          poolItem.context = context;
          poolItem.page = page;
          poolItem.hasActiveThread = false;
          poolItem.isCdp = this.isCdpConnection;
          poolItem.ownsBrowser = ownsBrowser;
          poolItem.ownsContext = ownsContext;
          poolItem.ownsPage = ownsPage;
          poolItem.lastUsedAt = Date.now();
        }
      }

      this.currentResources = {
        browser,
        context,
        page,
        hasActiveThread: poolItem?.hasActiveThread ?? false,
        isCdp: this.isCdpConnection,
        ownsBrowser,
        ownsContext,
        ownsPage
      };

      let anomaly = await abortableRace(this.adapter.detectAnomaly(page!), signal, 'Anomaly detection cancelled.');
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
          throwIfAborted(signal);
          try {
            const isTextareaPresent = await withStageTimeout('input readiness', timeouts.inputReadyMs, this.adapter.isInputReady(page!), signal);
            if (isTextareaPresent) {
              authenticated = true;
              break;
            }
          } catch {
            // Ignore evaluator errors while page is transitioning.
          }
          await abortableDelay(2000, signal);
        }

        if (!authenticated) {
          throw new InterventionRequiredError('Authentication intervention timed out after 5 minutes.', 'auth_expiry');
        }

        if (!this.isCdpConnection) {
          console.log('Authentication successful! Extracting and encrypting storage state...');
          const newState = await abortableRace(context!.storageState(), signal, 'Session save cancelled.');
          await abortableRace(SessionManager.saveSession(this.adapter.providerId, newState), signal, 'Session save cancelled.');
          console.log('Session saved successfully.');
        } else {
          console.log('Authentication successful!');
        }
        anomaly = 'NONE';
      }

      if (anomaly !== 'NONE') {
        throw new InterventionRequiredError(`Execution blocked by anomaly: ${anomaly}`, anomaly === 'CAPTCHA' ? 'captcha_intervention' : 'provider_intervention');
      }

      const maxChars = (this.adapter as any).maxPromptChars as number ?? 80_000;
      if (!options.pasteOnly && prompt.length > maxChars) {
        const chunks = splitPromptIntoChunks(prompt, maxChars, `${this.adapter.providerId} prompt`);
        console.log(`[CHUNKING] ✂️ Prompt (${prompt.length} chars) exceeds ${maxChars}-char limit for [${this.adapter.providerId.toUpperCase()}]. Splitting into ${chunks.length} chunks via multi-segment path...`);
        return await withStageTimeout('provider execution', timeouts.providerExecutionMs, this.adapter.dispatchMultiSegmentPrompt(page!, chunks), signal);
      }

      this.transitionTo('DISPATCHING');
      await withStageTimeout('submission', timeouts.submissionMs, this.adapter.dispatchPrompt(page!, prompt, options), signal);
      submissionConfirmed = true;
      DBService.markTaskSubmissionConfirmed(this.taskId);

      if (options.pasteOnly) {
        console.log('\n============================================================');
        console.log('⚠️ [MANUAL INTERVENTION] Socratic Critic prompt has been pasted.');
        console.log('Please review, edit, or submit the prompt manually in the browser.');
        console.log('Once the model has finished responding, press ENTER in this terminal to continue...');
        console.log('============================================================\n');

        const rlInterface = (await import('readline')).createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        await abortableRace(new Promise<void>((resolve) => {
          rlInterface.question('Press ENTER when response is ready to extract...', () => {
            rlInterface.close();
            resolve();
          });
        }), signal, 'Manual extraction wait cancelled.');

        this.transitionTo('EXTRACTING');
        const markdown = await abortableRace(this.adapter.extractAndNormalizeAST(page!), signal, 'Extraction cancelled.');

        if (!markdown) {
          const err = new Error('Extraction yielded empty markdown output.');
          (err as any).failure_class = 'empty_extraction';
          (err as any).submissionConfirmed = submissionConfirmed;
          throw err;
        }

        await this.persistExtractedResponse(markdown, 'clean');
        this.transitionTo('COMPLETE');

        if (!this.isCdpConnection) {
          const finalState = await abortableRace(context!.storageState(), signal, 'Session save cancelled.');
          await abortableRace(SessionManager.saveSession(this.adapter.providerId, finalState), signal, 'Session save cancelled.');
        }

        return markdown;
      }

      this.transitionTo('STREAMING');
      try {
        await withStageTimeout('output stabilization', timeouts.outputStabilizationMs, this.adapter.awaitNetworkCompletion(page!, {
          signal,
          firstTokenMs: timeouts.firstTokenMs,
          outputStabilizationMs: timeouts.outputStabilizationMs
        }), signal);
      } catch (completionErr: any) {
        if (isAbortError(completionErr)) throw completionErr;
        const forcedMarkdown = await this.forceExtractAfterCompletionFailure(page!, completionErr, signal);
        if (forcedMarkdown) {
          if (!this.isCdpConnection) {
            const finalState = await abortableRace(context!.storageState(), signal, 'Session save cancelled.');
            await abortableRace(SessionManager.saveSession(this.adapter.providerId, finalState), signal, 'Session save cancelled.');
          }
          return forcedMarkdown;
        }
        throw completionErr;
      }

      this.transitionTo('STABILIZING');
      await abortableDelay(500, signal);

      this.transitionTo('EXTRACTING');
      const markdown = await abortableRace(this.adapter.extractAndNormalizeAST(page!), signal, 'Extraction cancelled.');

      if (!markdown) {
        const err = new Error('Extraction yielded empty markdown output.');
        (err as any).failure_class = 'empty_extraction';
        (err as any).submissionConfirmed = submissionConfirmed;
        throw err;
      }

      await this.persistExtractedResponse(markdown, 'clean');
      this.transitionTo('COMPLETE');

      if (!this.isCdpConnection) {
        const finalState = await abortableRace(context!.storageState(), signal, 'Session save cancelled.');
        await abortableRace(SessionManager.saveSession(this.adapter.providerId, finalState), signal, 'Session save cancelled.');
      }

      return markdown;
    } catch (error: any) {
      console.error(`Task execution failed: ${error.message}`);

      const cancelled = isAbortError(error);
      const failure = classifyFailure(error, submissionConfirmed);
      (error as any).submissionConfirmed = failure.submissionConfirmed;
      (error as any).failure_code = failure.code;
      DBService.failTaskWithClassification(this.taskId, cancelled ? 'CANCELLED' : 'FAILED', failure.code, failure.submissionConfirmed);
      if (this.manageRunStatus) {
        DBService.updateRunStatusIfNotTerminal(this.runId, cancelled ? 'CANCELLED' : 'FAILED');
      }
      this.transitionTo(cancelled ? 'CANCELLED' : 'FAILED');

      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!poolItem) {
        await closeSessionItem({
          browser,
          context,
          page,
          hasActiveThread: false,
          isCdp: this.isCdpConnection,
          ownsBrowser,
          ownsContext,
          ownsPage
        }, 'runner finally').catch(() => {});
      }
      this.currentResources = null;
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
        DBService.updateRunStatusIfNotTerminal(this.runId, 'COMPLETED');
      }
      return response;
    }

    this.stateStartTime = Date.now();
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

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
          page = await context!.newPage();
          poolItem.page = page;
          poolItem.hasActiveThread = false;
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
        await page!.goto(this.adapter.baseUrl, { waitUntil: 'domcontentloaded' });

        if (poolItem) {
          poolItem.browser = browser;
          poolItem.context = context;
          poolItem.page = page;
          poolItem.hasActiveThread = false;
          poolItem.isCdp = this.isCdpConnection;
        }
      }

      // Anomaly / Session Check (same as executeTask)
      let anomaly = await this.adapter.detectAnomaly(page!);
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
            const isTextareaPresent = await this.adapter.isInputReady(page!);
            if (isTextareaPresent) {
              authenticated = true;
              break;
            }
          } catch {
            // Ignore evaluator errors while page is transitioning
          }
          await page!.waitForTimeout(2000);
        }

        if (!authenticated) {
          throw new InterventionRequiredError('Authentication intervention timed out after 5 minutes.', 'auth_expiry');
        }

        if (!this.isCdpConnection) {
          console.log('Authentication successful! Extracting and encrypting storage state...');
          const newState = await context!.storageState();
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
      const markdown = await this.adapter.dispatchMultiSegmentPrompt(page!, segments);
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
        const finalState = await context!.storageState();
        await SessionManager.saveSession(this.adapter.providerId, finalState);
      }

      return markdown;
    } catch (error: any) {
      console.error(`Multi-segment task execution failed: ${error.message}`);
      
      DBService.updateTaskStatus(this.taskId, 'FAILED');
      if (this.manageRunStatus) {
        DBService.updateRunStatusIfNotTerminal(this.runId, 'FAILED');
      }
      this.transitionTo('FAILED');
      
      throw error;
    } finally {
      if (!poolItem) {
        await closeSessionItem({
          browser,
          context,
          page,
          hasActiveThread: false,
          isCdp: this.isCdpConnection,
          ownsBrowser: !this.isCdpConnection,
          ownsContext: true,
          ownsPage: true
        }, 'multi-segment finally').catch(() => {});
      }
    }
  }
}
