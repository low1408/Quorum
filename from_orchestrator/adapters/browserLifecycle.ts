import type { Page, Response } from 'playwright';

type ResponseListener = (response: Response) => void;
type ResponseEventSource = Pick<Page, 'on' | 'off'>;

export class ConversationResponseTracker {
  private page: ResponseEventSource | null = null;
  private listener: ResponseListener | null = null;
  private activeResponse: Promise<Response> | null = null;

  arm(page: ResponseEventSource, conversationUrlPart: string | undefined): Promise<Response> | null {
    this.clear();
    if (!conversationUrlPart) return null;

    this.activeResponse = new Promise<Response>(resolve => {
      this.page = page;
      this.listener = response => {
        if (
          response.url().includes(conversationUrlPart)
          && response.request().method() === 'POST'
        ) {
          resolve(response);
          this.detachListener();
        }
      };
      page.on('response', this.listener);
    });

    return this.activeResponse;
  }

  get response(): Promise<Response> | null {
    return this.activeResponse;
  }

  clear(): void {
    this.detachListener();
    this.activeResponse = null;
  }

  private detachListener(): void {
    if (this.page && this.listener) {
      this.page.off('response', this.listener);
    }
    this.page = null;
    this.listener = null;
  }
}

export async function waitForAbortablePageTimeout(
  page: Pick<Page, 'waitForTimeout'>,
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await page.waitForTimeout(ms);
    return;
  }

  if (signal.aborted) throw abortError(signal);

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([page.waitForTimeout(ms), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function abortError(signal: AbortSignal): Error {
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'Operation cancelled.');
  error.name = 'AbortError';
  (error as Error & { code?: string }).code = 'CANCELLED';
  return error;
}
