import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../from_orchestrator/config/index.ts';
import { validateCouncilContext, validateCouncilRequestText } from '../from_orchestrator/mcp/contextValidation.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function structuredReviewContext() {
  return {
    review_objective: 'Review lifecycle behavior.',
    architecture: 'mcp -> validation -> council -> runner -> db',
    execution_flow: 'consult_council validates context, runs providers, persists tasks, returns report.',
    assumptions_and_invariants: 'Terminal task states are not overwritten.',
    core_evidence: 'Complete council and runner paths are included.',
    supporting_contracts: 'Adapter and session pool contracts are included.',
    privacy_and_persistence: 'Secret checks and DB status updates are included.',
    tests_and_runtime_evidence: 'npm test output and sanitized rows are included.',
    omitted_material: 'Provider-specific adapters are omitted as peripheral.'
  };
}

test('rejects malformed, duplicate, empty, oversized, binary, secret, and stale context', () => {
  assert.throws(() => validateCouncilContext({ files: [{ path: '../x.ts', content: 'x' }] }), /escapes/);
  assert.throws(() => validateCouncilContext({ files: [
    { path: 'a.ts', content: 'x' },
    { path: './a.ts', content: 'y' }
  ] }), /Duplicate/);
  assert.throws(() => validateCouncilContext({ files: [{ path: 'a.ts', content: '   ' }] }), /empty/);
  assert.throws(() => validateCouncilContext({ files: [{ path: 'a.ts', content: 'x'.repeat(250_001) }] }), /exceeds/);
  assert.throws(() => validateCouncilContext({ files: [{ path: 'a.bin', content: 'abc\0def' }] }), /binary/);
  assert.throws(() => validateCouncilContext({ files: [{ path: 'a.env', content: 'API_KEY=abcdefghijklmnopqrstuvwxyz123456' }] }), /secret/);
  assert.throws(() => validateCouncilContext({ files: [{ path: 'a.ts', content: 'x', sha256: digest('y') }] }), /stale|incorrect/);
});

test('rejects unknown fields, unsafe request text, unsafe metadata, and sensitive paths', () => {
  assert.throws(
    () => validateCouncilContext({
      files: [{ path: 'virtual.ts', content: 'export const value = 1;', unknown: true } as any]
    }),
    /unknown field/
  );
  assert.throws(
    () => validateCouncilContext({
      files: [{ path: '.env', content: 'SAFE_PLACEHOLDER=1' }]
    }),
    /sensitive/
  );
  assert.throws(
    () => validateCouncilContext({
      files: [{ path: 'sessions/state.json', content: '{}' }]
    }),
    /sensitive/
  );
  assert.throws(
    () => validateCouncilContext({
      files: [{ path: 'virtual.ts', content: 'export const value = 1;', relevance: 'abc\0def' }]
    }),
    /relevance.*binary/
  );
  assert.throws(
    () => validateCouncilRequestText('Review this.', 'API_KEY=abcdefghijklmnopqrstuvwxyz123456'),
    /Constraints.*secret/
  );

  const validation = validateCouncilContext({
    files: [{ path: '.env.example', content: 'SAFE_PLACEHOLDER=1' }]
  });
  assert.equal(validation.files[0].normalizedPath, '.env.example');
});

test('detects disk-stale hashes and warns about missing local imports', () => {
  const packagePath = path.resolve(config.rootDir, 'package.json');
  const wrongContent = '{"name":"not-current"}';
  assert.ok(fs.existsSync(packagePath), 'package.json fixture should exist after scaffolding');
  assert.throws(
    () => validateCouncilContext({
      files: [{ path: 'package.json', content: wrongContent, sha256: digest(wrongContent) }]
    }),
    /stale relative to disk/
  );

  const validation = validateCouncilContext({
    files: [{
      path: 'from_orchestrator/engine/council.ts',
      content: "import { validateCouncilContext } from '../mcp/contextValidation.ts';\nexport const x = 1;"
    }]
  }, 'implement a TypeScript fix');

  assert.match(validation.warnings.join('\n'), /omitted local imports/);
  assert.match(validation.warnings.join('\n'), /package\.json/);
});

test('warns when structured review paths contradict supplied files', () => {
  const validation = validateCouncilContext({
    files: [
      { path: 'from_orchestrator/engine/council.ts', content: 'export const value = 1;' },
      { path: 'tests/council.test.ts', content: 'test("x", () => {});' }
    ],
    structured_review: {
      ...structuredReviewContext(),
      core_evidence: 'Review from_orchestrator/mcp/contextValidation.ts and from_orchestrator/engine/council.ts.',
      omitted_material: 'tests/council.test.ts was omitted.'
    }
  });

  assert.match(validation.warnings.join('\n'), /core_evidence references from_orchestrator\/mcp\/contextValidation\.ts/);
  assert.match(validation.warnings.join('\n'), /omitted_material says tests\/council\.test\.ts is omitted/);
});

test('structured review context is optional unless enforcement is enabled', () => {
  const previous = config.requireStructuredReviewContext;
  config.requireStructuredReviewContext = false;
  try {
    const validation = validateCouncilContext({
      files: [{ path: 'virtual.ts', content: 'export const value = 1;' }]
    });

    assert.equal(validation.structured_review, undefined);
  } finally {
    config.requireStructuredReviewContext = previous;
  }
});

test('enforced structured review context rejects raw-only and incomplete requests', () => {
  const previous = config.requireStructuredReviewContext;
  config.requireStructuredReviewContext = true;
  try {
    assert.throws(
      () => validateCouncilContext({
        files: [{ path: 'virtual.ts', content: 'export const value = 1;' }]
      }),
      /Structured review context is required/
    );

    assert.throws(
      () => validateCouncilContext({
        files: [{ path: 'virtual.ts', content: 'export const value = 1;' }],
        structured_review: {
          ...structuredReviewContext(),
          omitted_material: ''
        }
      }),
      /omitted_material/
    );
  } finally {
    config.requireStructuredReviewContext = previous;
  }
});

test('enforced structured review context preserves validated fields', () => {
  const previous = config.requireStructuredReviewContext;
  config.requireStructuredReviewContext = true;
  try {
    const structured = structuredReviewContext();
    const validation = validateCouncilContext({
      files: [{ path: 'virtual.ts', content: 'export const value = 1;' }],
      structured_review: structured
    });

    assert.deepEqual(validation.structured_review, structured);
  } finally {
    config.requireStructuredReviewContext = previous;
  }
});
