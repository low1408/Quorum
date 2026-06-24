import assert from 'node:assert/strict';
import test from 'node:test';

import { DBService, initSchema } from '../from_orchestrator/db/database.ts';
import { handleMaterializeValidationTests } from '../from_orchestrator/mcp/server.ts';
import type { CouncilRunnerFactory } from '../from_orchestrator/engine/council.ts';

function metricIdsBefore(): Set<string> {
  initSchema();
  const rows = DBService.getMcpToolCallMetrics({ toolName: 'materialize_validation_tests' });
  return new Set(rows.map(row => row.tool_call_id));
}

function newMaterializeMetrics(before: Set<string>): any[] {
  return DBService.getMcpToolCallMetrics({ toolName: 'materialize_validation_tests' })
    .filter(row => !before.has(row.tool_call_id));
}

function validContext() {
  return {
    files: [{
      path: 'src/pool.ts',
      content: 'export function release() { return true; }',
      relevance: 'implementation under review'
    }]
  };
}

function validFindings() {
  return [{
    id: 'F1',
    classification: 'Confirmed defect',
    severity: 'High',
    description: 'Release can race with acquisition.',
    evidence: 'src/pool.ts:1',
    validation_test: 'Add a concurrent release/acquire regression test.'
  }];
}

function validPatch(): string {
  return [
    'diff --git a/tests/pool.test.ts b/tests/pool.test.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/tests/pool.test.ts',
    '@@ -0,0 +1,3 @@',
    "+import test from 'node:test';",
    "+test('covers pool race', () => {});",
    '+'
  ].join('\n');
}

test('materialize_validation_tests returns structured patch content without report artifacts', async () => {
  const before = metricIdsBefore();
  let promptSeen = '';
  const runnerFactory: CouncilRunnerFactory = () => ({
    async executeTask(prompt) {
      promptSeen = prompt;
      return JSON.stringify({
        test_patch: validPatch(),
        tests: [{
          path: 'tests/pool.test.ts',
          target_finding_id: 'F1',
          assertion_summary: 'covers concurrent pool release/acquire behavior'
        }],
        uncovered_findings: [],
        warnings: []
      });
    },
    async close() {}
  });

  const response = await handleMaterializeValidationTests({
    objective: 'Generate validation tests.',
    findings: validFindings(),
    context: validContext(),
    provider: 'mock',
    runnerFactory
  });

  const result = response.structuredContent;
  const metrics = newMaterializeMetrics(before);
  assert.equal(result.status, 'COMPLETED');
  assert.match(result.test_patch, /diff --git a\/tests\/pool\.test\.ts/);
  assert.equal(result.tests[0].target_finding_id, 'F1');
  assert.equal('artifact' in result, false);
  assert.match(promptSeen, /Return ONLY a valid JSON object/);
  assert.match(promptSeen, /Do not write production code/);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'COMPLETED');
  assert.equal(metrics[0].requested_provider_count, 1);
  assert.equal(metrics[0].successful_provider_count, 1);
  assert.equal(metrics[0].failed_provider_count, 0);
  assert.match(metrics[0].context_digest, /^[a-f0-9]{64}$/);
});

test('materialize_validation_tests rejects invalid inputs before provider execution', async () => {
  let executed = false;
  const runnerFactory: CouncilRunnerFactory = () => ({
    async executeTask() {
      executed = true;
      return '{}';
    },
    async close() {}
  });

  await assert.rejects(
    handleMaterializeValidationTests({
      objective: 'Generate validation tests.',
      findings: [],
      context: validContext(),
      provider: 'mock',
      runnerFactory
    }),
    /At least one validation-test finding/
  );

  assert.equal(executed, false);
});
