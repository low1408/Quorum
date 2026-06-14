import assert from 'node:assert/strict';
import test from 'node:test';
import { getDB, initSchema } from '../from_orchestrator/db/database.ts';
import { OrchestrationRunner } from '../from_orchestrator/engine/runner.ts';
import type { SessionPoolItem } from '../from_orchestrator/engine/providerSessionPool.ts';

test('runner force-extracts visible output when completion wait reports a late anomaly', async () => {
  initSchema();

  const runId = `runner_forced_extract_${Date.now()}`;
  const taskId = `${runId}_task`;
  const runner = new OrchestrationRunner(runId, taskId, 'mock', { manageRunStatus: false });

  (runner as any).adapter = {
    providerId: 'late-anomaly-provider',
    type: 'browser',
    baseUrl: 'https://example.test',
    healthCheck: async () => ({ healthy: true }),
    initSession: async () => {},
    dispatchPrompt: async () => {},
    dispatchMultiSegmentPrompt: async () => '',
    awaitNetworkCompletion: async () => {
      throw new Error('Generation blocked by anomaly: RATE_LIMITED');
    },
    extractAndNormalizeAST: async () => 'visible consolidated report',
    detectAnomaly: async () => 'NONE',
    isInputReady: async () => true
  };

  const fakePage = {
    isClosed: () => false,
    waitForTimeout: async () => {}
  };

  const result = await runner.executeTask('summarize completed council output', {
    browser: {},
    context: {},
    page: fakePage,
    hasActiveThread: false,
    isCdp: true
  } as unknown as SessionPoolItem);

  assert.equal(result, 'visible consolidated report');

  const task = getDB().prepare('SELECT response_text, extraction_method, status FROM Tasks WHERE task_id = ?').get(taskId) as any;
  assert.equal(task.response_text, 'visible consolidated report');
  assert.equal(task.extraction_method, 'timeout_forced');
  assert.equal(task.status, 'COMPLETED');
});
