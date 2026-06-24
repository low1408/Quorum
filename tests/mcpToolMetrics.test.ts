import assert from 'node:assert/strict';
import test from 'node:test';

import { DBService, getDB, initSchema } from '../from_orchestrator/db/database.ts';
import { handleConsultCouncil } from '../from_orchestrator/mcp/server.ts';
import type { CouncilRunnerFactory } from '../from_orchestrator/engine/council.ts';

function metricIdsBefore(): Set<string> {
  initSchema();
  const rows = DBService.getMcpToolCallMetrics({ toolName: 'consult_council' });
  return new Set(rows.map(row => row.tool_call_id));
}

function newCouncilMetrics(before: Set<string>): any[] {
  return DBService.getMcpToolCallMetrics({ toolName: 'consult_council' })
    .filter(row => !before.has(row.tool_call_id));
}

function validContext() {
  return {
    files: [{
      path: 'virtual.ts',
      content: 'export function add(a: number, b: number) { return a + b; }'
    }],
    notes: 'Metric test context.'
  };
}

test('invalid council context records a validation-failed MCP metric without a run', async () => {
  const before = metricIdsBefore();

  await assert.rejects(
    handleConsultCouncil({
      question: 'Review this file.',
      context: {
        files: [{ path: '../outside.ts', content: 'export const value = 1;' }]
      },
      providers: ['mock']
    }),
    /escapes/
  );

  const metrics = newCouncilMetrics(before);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'VALIDATION_FAILED');
  assert.equal(metrics[0].run_id, null);
  assert.equal(metrics[0].requested_provider_count, 1);
  assert.equal(metrics[0].successful_provider_count, 0);
  assert.equal(metrics[0].failed_provider_count, 0);
  assert.match(metrics[0].error_message, /escapes/);
  assert.ok(metrics[0].completed_at);
});

test('unsupported council provider records a validation-failed MCP metric without a run', async () => {
  const beforeMetrics = metricIdsBefore();
  const beforeRuns = (getDB().prepare('SELECT COUNT(*) AS count FROM Runs').get() as any).count;

  await assert.rejects(
    handleConsultCouncil({
      question: 'Review this file.',
      context: validContext(),
      providers: ['chatgpt-typo']
    }),
    /Unsupported provider IDs: chatgpt-typo/
  );

  const afterRuns = (getDB().prepare('SELECT COUNT(*) AS count FROM Runs').get() as any).count;
  const metrics = newCouncilMetrics(beforeMetrics);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'VALIDATION_FAILED');
  assert.equal(metrics[0].run_id, null);
  assert.equal(metrics[0].requested_provider_count, 1);
  assert.equal(afterRuns, beforeRuns);
});

test('successful mock council call records a completed MCP metric', async () => {
  const before = metricIdsBefore();

  const response = await handleConsultCouncil({
    question: 'Review this function.',
    context: validContext(),
    providers: ['mock'],
    max_retries: 0
  });

  const result = response.structuredContent;
  const metrics = newCouncilMetrics(before);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'COMPLETED');
  assert.equal(metrics[0].run_id, result.run_id);
  assert.equal(metrics[0].requested_provider_count, 1);
  assert.equal(metrics[0].successful_provider_count, 1);
  assert.equal(metrics[0].failed_provider_count, 0);
  assert.match(metrics[0].context_digest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(metrics[0].duration_ms));
});

test('partial provider failure records a partial-success MCP metric', async () => {
  const before = metricIdsBefore();
  const runnerFactory: CouncilRunnerFactory = ({ provider }) => ({
    async executeTask() {
      if (provider === 'chatgpt') {
        throw new Error('simulated provider failure');
      }
      return `analysis from ${provider}`;
    },
    async close() {}
  });

  const response = await handleConsultCouncil({
    question: 'Review this function.',
    context: validContext(),
    providers: ['mock', 'chatgpt'],
    max_retries: 0,
    runnerFactory
  });

  const result = response.structuredContent;
  const metrics = newCouncilMetrics(before);
  assert.equal(result.status, 'PARTIAL_SUCCESS');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'PARTIAL_SUCCESS');
  assert.equal(metrics[0].run_id, result.run_id);
  assert.equal(metrics[0].requested_provider_count, 2);
  assert.equal(metrics[0].successful_provider_count, 1);
  assert.equal(metrics[0].failed_provider_count, 1);
});
