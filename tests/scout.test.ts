import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { config } from '../from_orchestrator/config/index.ts';
import { DBService, initSchema } from '../from_orchestrator/db/database.ts';
import { handleScoutDiscoverContext } from '../from_orchestrator/mcp/server.ts';
import {
  discoverScoutContext,
  discoverScoutContextWithLlm,
  type ScoutLlmRunner
} from '../from_orchestrator/tools/scout.ts';

function paths(result: { recommended_files: Array<{ path: string }> }): string[] {
  return result.recommended_files.map(file => file.path);
}

function scoutMetricIdsBefore(): Set<string> {
  initSchema();
  const rows = DBService.getMcpToolCallMetrics({ toolName: 'scout_discover_context' });
  return new Set(rows.map(row => row.tool_call_id));
}

function newScoutMetrics(before: Set<string>): any[] {
  return DBService.getMcpToolCallMetrics({ toolName: 'scout_discover_context' })
    .filter(row => !before.has(row.tool_call_id));
}

function jsonResponse(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function validLlmReview(pathValue = 'from_orchestrator/security/encryption.ts') {
  return {
    structured_review: {
      review_objective: `Review ChatGPT-selected context for ${pathValue}.`,
      architecture: `${pathValue} contains the encryption helper implementation selected for review.`,
      execution_flow: `Callers rely on ${pathValue} to encrypt and decrypt serialized values.`,
      assumptions_and_invariants: 'Selected repository files remain authoritative; this briefing was drafted from bounded excerpts.',
      core_evidence: `${pathValue} is the primary implementation evidence.`,
      supporting_contracts: 'No additional selected supporting contracts are required for this focused briefing.',
      privacy_and_persistence: 'The selected evidence concerns encryption behavior and does not include real secret files.',
      tests_and_runtime_evidence: 'No runtime evidence or nearby tests were selected for this focused query.',
      omitted_material: 'No omitted file paths are required for this briefing.'
    }
  };
}

function fakeLlmRunner(params: {
  ranking: string | Error;
  briefing?: string | Error;
  calls?: string[];
}): ScoutLlmRunner {
  return async ({ phase }) => {
    params.calls?.push(phase);
    const response = phase === 'ranking' ? params.ranking : params.briefing;
    if (response instanceof Error) throw response;
    if (typeof response === 'string') return response;
    throw new Error(`No fake response configured for ${phase}`);
  };
}

test('scout_discover_context includes local imports and TypeScript config files', () => {
  const result = discoverScoutContext({
    query: 'implement a TypeScript fix for sessionManager.ts session encryption lifecycle',
    entrypoints: ['from_orchestrator/security/sessionManager.ts'],
    include_reverse_importers: false,
    include_tests: false
  });

  const selected = paths(result);
  assert.ok(selected.includes('from_orchestrator/security/sessionManager.ts'));
  assert.ok(selected.includes('from_orchestrator/security/encryption.ts'));
  assert.ok(selected.includes('from_orchestrator/config/index.ts'));
  assert.ok(selected.includes('package.json'));
  assert.ok(selected.includes('tsconfig.json'));
  assert.match(result.context_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.context.files.length, result.recommended_files.length);
  assert.equal(result.context.evidence_manifest?.length, result.recommended_files.length);
});

test('scout_discover_context reports missing and unsafe explicit paths', () => {
  const result = discoverScoutContext({
    query: 'Review missing.ts',
    entrypoints: ['.env', 'missing.ts', 'from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false
  });

  assert.ok(paths(result).includes('from_orchestrator/security/encryption.ts'));
  assert.match(result.warnings.join('\n'), /unsafe path \.env/);
  assert.match(result.warnings.join('\n'), /could not find referenced file: missing\.ts/);
  assert.ok(result.omitted_files.some(file => file.path === '.env' && file.reason === 'unsafe path'));
});

test('scout_discover_context preserves core files when pruning to budget', () => {
  const result = discoverScoutContext({
    query: 'implement a TypeScript fix for sessionManager.ts',
    entrypoints: ['from_orchestrator/security/sessionManager.ts'],
    token_budget_chars: 2300,
    include_reverse_importers: false,
    include_tests: false
  });

  assert.ok(paths(result).includes('from_orchestrator/security/sessionManager.ts'));
  assert.ok(!paths(result).includes('from_orchestrator/security/encryption.ts'));
  assert.ok(result.omitted_files.some(file => file.path === 'from_orchestrator/security/encryption.ts'));
  assert.ok(result.stats.total_chars <= 2300);
  assert.match(result.warnings.join('\n'), /omitted local imports/);
});

test('scout_discover_context adds nearby tests for implementation queries', () => {
  const result = discoverScoutContext({
    query: 'implement an MCP context validation fix in from_orchestrator/mcp/contextValidation.ts',
    entrypoints: ['from_orchestrator/mcp/contextValidation.ts'],
    token_budget_chars: 450000,
    include_reverse_importers: false
  });

  const selected = paths(result);
  assert.ok(selected.includes('from_orchestrator/mcp/contextValidation.ts'));
  assert.ok(selected.includes('tests/contextValidation.test.ts'));
  assert.ok(selected.includes('package.json'));
  assert.ok(selected.includes('tsconfig.json'));
});

test('scout_discover_context async wrapper remains deterministic unless LLM is requested', async () => {
  const calls: string[] = [];
  const result = await discoverScoutContextWithLlm({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false
  }, {
    runLlm: fakeLlmRunner({
      ranking: new Error('runner should not be called'),
      calls
    })
  });

  assert.equal(result.stats.strategy, 'deterministic-v1');
  assert.equal(result.stats.llm, undefined);
  assert.deepEqual(calls, []);
  assert.ok(paths(result).includes('from_orchestrator/security/encryption.ts'));
});

test('scout_discover_context applies valid ChatGPT ranking and structured review', async () => {
  const deterministic = discoverScoutContext({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false
  });

  const result = await discoverScoutContextWithLlm({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false,
    enhance_with_llm: true
  }, {
    now: () => 1000,
    runLlm: fakeLlmRunner({
      ranking: jsonResponse({
        ranked_files: [{
          path: 'from_orchestrator/security/encryption.ts',
          relevance_score: 0.99,
          relevance_reason: 'Primary encryption implementation for the review.'
        }]
      }),
      briefing: jsonResponse(validLlmReview())
    })
  });

  const encryption = result.recommended_files.find(file => file.path === 'from_orchestrator/security/encryption.ts');
  assert.equal(result.stats.strategy, 'chatgpt-full-briefing-v1');
  assert.equal(result.stats.llm?.ranking_applied, true);
  assert.equal(result.stats.llm?.briefing_applied, true);
  assert.match(encryption?.relevance_reason || '', /ChatGPT rerank: Primary encryption implementation/);
  assert.match(result.context.notes || '', /ChatGPT-generated structured_review/);
  assert.match(result.context.structured_review?.architecture || '', /encryption helper implementation/);
  assert.notEqual(result.context_digest, deterministic.context_digest);
});

test('scout_discover_context ignores invalid ChatGPT ranked paths', async () => {
  const result = await discoverScoutContextWithLlm({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false,
    enhance_with_llm: true
  }, {
    runLlm: fakeLlmRunner({
      ranking: jsonResponse({
        ranked_files: [
          {
            path: 'not_real.ts',
            relevance_score: 1,
            relevance_reason: 'Invented path that must be ignored.'
          },
          {
            path: 'from_orchestrator/security/encryption.ts',
            relevance_score: 0.98,
            relevance_reason: 'Valid deterministic candidate.'
          }
        ]
      }),
      briefing: jsonResponse(validLlmReview())
    })
  });

  assert.equal(result.stats.strategy, 'chatgpt-full-briefing-v1');
  assert.match(result.warnings.join('\n'), /not a deterministic candidate: not_real\.ts/);
  assert.ok(paths(result).includes('from_orchestrator/security/encryption.ts'));
});

test('scout_discover_context falls back when ChatGPT ranking is malformed', async () => {
  const result = await discoverScoutContextWithLlm({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false,
    enhance_with_llm: true
  }, {
    runLlm: fakeLlmRunner({
      ranking: 'not json'
    })
  });

  assert.equal(result.stats.strategy, 'chatgpt-fallback-v1');
  assert.equal(result.stats.llm?.ranking_applied, false);
  assert.equal(result.stats.llm?.briefing_applied, false);
  assert.match(result.stats.llm?.fallback_reason || '', /valid JSON object/);
  assert.doesNotMatch(result.recommended_files[0].relevance_reason, /ChatGPT rerank/);
});

test('scout_discover_context keeps ranking when ChatGPT briefing is invalid', async () => {
  const result = await discoverScoutContextWithLlm({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false,
    enhance_with_llm: true
  }, {
    runLlm: fakeLlmRunner({
      ranking: jsonResponse({
        ranked_files: [{
          path: 'from_orchestrator/security/encryption.ts',
          relevance_score: 0.99,
          relevance_reason: 'Ranking should survive invalid briefing.'
        }]
      }),
      briefing: jsonResponse({
        structured_review: {
          review_objective: 'Missing the other required fields.'
        }
      })
    })
  });

  const encryption = result.recommended_files.find(file => file.path === 'from_orchestrator/security/encryption.ts');
  assert.equal(result.stats.strategy, 'chatgpt-partial-v1');
  assert.equal(result.stats.llm?.ranking_applied, true);
  assert.equal(result.stats.llm?.briefing_applied, false);
  assert.match(encryption?.relevance_reason || '', /Ranking should survive invalid briefing/);
  assert.match(result.context.structured_review?.architecture || '', /Scout selected files deterministically/);
  assert.match(result.warnings.join('\n'), /ChatGPT briefing rejected/);
});

test('scout_discover_context falls back when ChatGPT runner fails', async () => {
  const result = await discoverScoutContextWithLlm({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false,
    enhance_with_llm: true
  }, {
    runLlm: fakeLlmRunner({
      ranking: new Error('Authentication expired')
    })
  });

  assert.equal(result.stats.strategy, 'chatgpt-fallback-v1');
  assert.equal(result.stats.llm?.ranking_applied, false);
  assert.equal(result.stats.llm?.briefing_applied, false);
  assert.match(result.warnings.join('\n'), /Authentication expired/);
  assert.ok(paths(result).includes('from_orchestrator/security/encryption.ts'));
});

test('scout_discover_context MCP handler returns structured context and records metrics', async () => {
  const before = scoutMetricIdsBefore();

  const response = await handleScoutDiscoverContext({
    query: 'Review from_orchestrator/security/encryption.ts',
    entrypoints: ['from_orchestrator/security/encryption.ts'],
    include_reverse_importers: false,
    include_tests: false
  });

  const result = response.structuredContent;
  const metrics = newScoutMetrics(before);
  assert.ok(paths(result).includes('from_orchestrator/security/encryption.ts'));
  assert.match(result.context_digest, /^[a-f0-9]{64}$/);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'COMPLETED');
  assert.equal(metrics[0].requested_provider_count, 0);
  assert.equal(metrics[0].successful_provider_count, 0);
  assert.equal(metrics[0].failed_provider_count, 0);
  assert.equal(metrics[0].context_digest, result.context_digest);
});

test('scout_discover_context MCP handler rejects invalid inputs before discovery succeeds', async () => {
  const before = scoutMetricIdsBefore();

  await assert.rejects(
    handleScoutDiscoverContext({
      query: 'Review package.json',
      repo_root: path.resolve(config.rootDir, '..')
    }),
    /repo_root must match/
  );

  await assert.rejects(
    handleScoutDiscoverContext({ query: '' }),
    /Question must be non-empty/
  );

  const metrics = newScoutMetrics(before);
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].status, 'VALIDATION_FAILED');
  assert.equal(metrics[1].status, 'VALIDATION_FAILED');
});
