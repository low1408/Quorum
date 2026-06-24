import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMaterializeValidationTestsPrompt,
  extractStrictJsonObject,
  validateMaterializedValidationTestsResponse
} from '../from_orchestrator/engine/validationTests.ts';
import { validateCouncilContext } from '../from_orchestrator/mcp/contextValidation.ts';

const findings = [{
  id: 'F1',
  classification: 'Confirmed defect',
  severity: 'High',
  description: 'Session release can race with acquisition.',
  evidence: 'src/pool.ts:42',
  validation_test: 'Add a concurrent acquire/release test that fails before the lock fix.'
}];

function validPatch(path = 'tests/pool.test.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,3 @@',
    "+import test from 'node:test';",
    "+test('covers pool race', () => {});",
    '+'
  ].join('\n');
}

test('materialize prompt includes objective, findings, validation prose, context, and patch-only constraints', () => {
  const context = validateCouncilContext({
    files: [{
      path: 'src/pool.ts',
      content: 'export function release() { return true; }',
      relevance: 'implementation under review'
    }]
  }, 'Generate validation tests.');

  const prompt = buildMaterializeValidationTestsPrompt({
    objective: 'Generate tests for the session pool findings.',
    findings,
    context,
    test_framework: 'auto',
    style_constraints: 'Use node:test and assert/strict.'
  });

  assert.match(prompt, /Generate tests for the session pool findings/);
  assert.match(prompt, /Do not write production code/);
  assert.match(prompt, /Return a unified diff that creates or edits test files only/);
  assert.match(prompt, /id=F1/);
  assert.match(prompt, /validation_test=Add a concurrent acquire\/release test/);
  assert.match(prompt, /TEST FRAMEWORK:\nnode:test/);
  assert.match(prompt, /STYLE CONSTRAINTS:\nUse node:test and assert\/strict/);
  assert.match(prompt, /path=src\/pool\.ts/);
  assert.match(prompt, /REPOSITORY EVIDENCE/);
});

test('strict JSON extraction accepts clean and fenced JSON and rejects prose or malformed JSON', () => {
  assert.deepEqual(extractStrictJsonObject('{"test_patch":"x","tests":[]}'), {
    test_patch: 'x',
    tests: []
  });
  assert.deepEqual(extractStrictJsonObject('```json\n{"test_patch":"x","tests":[]}\n```'), {
    test_patch: 'x',
    tests: []
  });
  assert.throws(() => extractStrictJsonObject('Here is the JSON: {"test_patch":"x"}'), /strict JSON/);
  assert.throws(() => extractStrictJsonObject('```json\n{"test_patch":\n```'), /malformed fenced JSON/);
});

test('materialized response validation rejects empty, production-code, and unmapped test patches', () => {
  assert.throws(
    () => validateMaterializedValidationTestsResponse({
      parsed: {
        test_patch: '',
        tests: [{ path: 'tests/pool.test.ts', target_finding_id: 'F1', assertion_summary: 'covers pool race' }]
      },
      findings,
      provider: 'mock'
    }),
    /test_patch must be non-empty/
  );

  assert.throws(
    () => validateMaterializedValidationTestsResponse({
      parsed: {
        test_patch: validPatch('src/pool.ts'),
        tests: [{ path: 'src/pool.ts', target_finding_id: 'F1', assertion_summary: 'covers pool race' }]
      },
      findings,
      provider: 'mock'
    }),
    /non-test path/
  );

  assert.throws(
    () => validateMaterializedValidationTestsResponse({
      parsed: {
        test_patch: validPatch(),
        tests: [{ path: 'tests/pool.test.ts', assertion_summary: 'covers pool race' }]
      },
      findings,
      provider: 'mock'
    }),
    /missing target_finding_id/
  );

  assert.throws(
    () => validateMaterializedValidationTestsResponse({
      parsed: {
        test_patch: validPatch(),
        tests: [{ path: 'tests/pool.test.ts', target_finding_id: 'F1', assertion_summary: 'covers pool race' }],
        uncovered_findings: []
      },
      findings: [
        ...findings,
        {
          id: 'F2',
          description: 'A second finding.',
          validation_test: 'Needs integration context.'
        }
      ],
      provider: 'mock'
    }),
    /neither covered/
  );
});

test('materialized response validation accepts valid patches and computes partial status', () => {
  const result = validateMaterializedValidationTestsResponse({
    parsed: {
      test_patch: validPatch(),
      tests: [{ path: 'tests/pool.test.ts', target_finding_id: 'F1', assertion_summary: 'covers pool race' }],
      uncovered_findings: [{ finding_id: 'F2', reason: 'not present' }],
      warnings: ['review generated test before applying']
    },
    findings: [
      ...findings,
      {
        id: 'F2',
        description: 'A second finding.',
        validation_test: 'Needs integration context.'
      }
    ],
    provider: 'mock'
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.provider, 'mock');
  assert.equal(result.tests[0].target_finding_id, 'F1');
  assert.equal(result.uncovered_findings[0].finding_id, 'F2');
});
