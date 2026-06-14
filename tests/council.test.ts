import assert from 'node:assert/strict';
import test from 'node:test';
import { initSchema } from '../from_orchestrator/db/database.ts';
import { buildCouncilConsolidationPrompt, runCouncilConsultation } from '../from_orchestrator/engine/council.ts';
import { validateCouncilContext } from '../from_orchestrator/mcp/contextValidation.ts';

test('consolidation prompt asks for an anonymous action-oriented report', () => {
  const prompt = buildCouncilConsolidationPrompt({
    question: 'How should this be implemented?',
    analyses: [
      { provider: 'mock', taskId: 'task1', response: 'Use a small wrapper.' }
    ]
  });

  assert.match(prompt, /Do not include provider names/);
  assert.match(prompt, /Recommendation, Options, Risks, Implementation Notes, Tests, Open Questions/);
  assert.doesNotMatch(prompt, /FROM \[MOCK\]/);
});

test('runCouncilConsultation completes with the mock adapter', async () => {
  initSchema();
  const context = validateCouncilContext({
    files: [{
      path: 'virtual.ts',
      content: 'export function add(a: number, b: number) { return a + b; }'
    }],
    notes: 'A small virtual file for mock integration.'
  }, 'Review this function.');

  const result = await runCouncilConsultation({
    question: 'Review this function and suggest implementation options.',
    context,
    providers: ['mock'],
    maxWaitMs: 30_000
  });

  assert.equal(result.status, 'COMPLETED');
  assert.match(result.run_id, /^council_run_/);
  assert.match(result.report, /Mock Response/);
  assert.ok(result.warnings.some(warning => warning.includes('virtual.ts')));
});
