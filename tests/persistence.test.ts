import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCouncilContext } from '../from_orchestrator/context/validation.ts';
import { runCouncilConsultation } from '../from_orchestrator/engine/council.ts';
import type { TaskPersistence } from '../from_orchestrator/engine/persistence.ts';
import { OrchestrationRunner } from '../from_orchestrator/engine/runner.ts';

function memoryPersistence() {
  const events: Array<{ operation: string; value: unknown }> = [];
  const persistence: TaskPersistence = {
    createRun: (runId, topic) => events.push({ operation: 'createRun', value: { runId, topic } }),
    updateRunStatusIfNotTerminal: (runId, status) => {
      events.push({ operation: 'updateRunStatus', value: { runId, status } });
      return true;
    },
    createTask: params => events.push({ operation: 'createTask', value: params }),
    updateTaskResponse: params => events.push({ operation: 'updateTaskResponse', value: params }),
    updateTaskStatus: (taskId, status) => events.push({ operation: 'updateTaskStatus', value: { taskId, status } }),
    markTaskSubmissionConfirmed: taskId => events.push({ operation: 'markTaskSubmissionConfirmed', value: taskId }),
    failTaskWithClassification: (taskId, status, failureCode, submissionConfirmed) => {
      events.push({ operation: 'failTask', value: { taskId, status, failureCode, submissionConfirmed } });
    },
    addTelemetry: params => events.push({ operation: 'addTelemetry', value: params })
  };
  return { persistence, events };
}

test('runner persists through an injected task port', async () => {
  const { persistence, events } = memoryPersistence();
  const runner = new OrchestrationRunner('memory-run', 'memory-task', 'mock', { persistence });

  const response = await runner.executeTask('test prompt');

  assert.match(response, /Mock Response/);
  assert.ok(events.some(event => event.operation === 'createTask'));
  assert.ok(events.some(event => event.operation === 'updateTaskResponse'));
  assert.ok(events.some(event => event.operation === 'updateRunStatus'));
});

test('council lifecycle persists through the same injected port', async () => {
  const { persistence, events } = memoryPersistence();
  const context = validateCouncilContext({
    files: [{ path: 'virtual.ts', content: 'export const value = 1;' }]
  }, 'Review this file.');

  const result = await runCouncilConsultation({
    question: 'Review this file.',
    context,
    providers: ['mock'],
    maxRetries: 0,
    persistence,
    runnerFactory: ({ provider, taskId }) => ({
      executeTask: async () => `analysis from ${provider} for ${taskId}`,
      close: async () => {}
    })
  });

  assert.equal(result.status, 'COMPLETED');
  const statuses = events
    .filter(event => event.operation === 'updateRunStatus')
    .map(event => (event.value as { status: string }).status);
  assert.deepEqual(statuses, ['IN_PROGRESS', 'COMPLETED']);
});
