import type { RunnerTimeoutBudgets } from './runner.ts';
import { classifyFailure, type FailureClassification } from './failures.ts';
import { ProviderSessionPool, type SessionPoolItem } from './providerSessionPool.ts';
import { createCancelledError } from './statuses.ts';

export type ProviderTaskRunner = {
  executeTask(prompt: string, poolItem?: SessionPoolItem, options?: {
    pasteOnly?: boolean;
    signal?: AbortSignal;
    timeouts?: Partial<RunnerTimeoutBudgets>;
    attemptNo?: number;
  }): Promise<string>;
  close(): Promise<void>;
};

export type ProviderTaskRunnerFactory = (params: {
  runId: string;
  taskId: string;
  provider: string;
}) => ProviderTaskRunner;

export type ProviderExecutionResult = {
  provider: string;
  taskId: string;
  response: string;
};

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await mapper(items[currentIndex], currentIndex) };
      } catch (reason) {
        results[currentIndex] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function retryBackoffMs(attemptNo: number, env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.COUNCIL_RETRY_BACKOFF_MS || '', 10);
  const base = Number.isFinite(configured) && configured >= 0 ? configured : 750;
  return base * attemptNo;
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function runProviderAttempt(params: {
  provider: string;
  index: number;
  runId: string;
  prompt: string;
  taskPrefix: string;
  pool: ProviderSessionPool;
  timeoutMs: number;
  timeoutDefaults?: Partial<RunnerTimeoutBudgets>;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  attemptNo: number;
  runnerFactory: ProviderTaskRunnerFactory;
}): Promise<ProviderExecutionResult> {
  const {
    provider,
    index,
    runId,
    prompt,
    taskPrefix,
    pool,
    timeoutMs,
    timeoutDefaults,
    timeouts,
    attemptNo,
    runnerFactory
  } = params;
  const taskId = `${taskPrefix}_${runId}_${index + 1}_${provider}_attempt_${attemptNo}`;
  const runner = runnerFactory({ runId, taskId, provider });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(createCancelledError(`${provider} timed out after ${timeoutMs}ms.`)),
    timeoutMs
  );
  timeout.unref();

  try {
    const session = pool.acquire(provider);
    const response = await runner.executeTask(prompt, session, {
      signal: controller.signal,
      timeouts: {
        providerExecutionMs: timeoutMs,
        ...timeoutDefaults,
        ...timeouts
      },
      attemptNo
    });
    session.hasActiveThread = true;
    session.lastUsedAt = Date.now();
    return { provider, taskId, response };
  } catch (error) {
    controller.abort(createCancelledError(`${provider} failed.`));
    await runner.close().catch(() => {});
    await pool.invalidate(provider, error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runProviderWithRetry(params: {
  provider: string;
  index: number;
  runId: string;
  prompt: string;
  taskPrefix: string;
  pool: ProviderSessionPool;
  timeoutMs: number;
  timeoutDefaults?: Partial<RunnerTimeoutBudgets>;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  maxRetries: number;
  runnerFactory: ProviderTaskRunnerFactory;
  warnings: string[];
  backoffMs?: (attemptNo: number) => number;
}): Promise<ProviderExecutionResult> {
  const { maxRetries, warnings, backoffMs = retryBackoffMs, ...attempt } = params;
  let lastFailure: FailureClassification | null = null;

  for (let attemptNo = 1; attemptNo <= maxRetries + 1; attemptNo++) {
    try {
      return await runProviderAttempt({ ...attempt, attemptNo });
    } catch (error) {
      const failure = classifyFailure(error);
      lastFailure = failure;
      warnings.push(`${attempt.provider} attempt ${attemptNo} failed with ${failure.code}: ${failure.publicMessage}`);

      if (!failure.retryable || attemptNo > maxRetries) throw error;
      await delay(backoffMs(attemptNo));
    }
  }

  throw new Error(lastFailure?.message || `${attempt.provider} failed after retries.`);
}
