import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { config } from '../from_orchestrator/config/index.ts';
import { DBService, initSchema } from '../from_orchestrator/db/database.ts';
import { handleScoutDiscoverContext } from '../from_orchestrator/mcp/server.ts';
import { discoverScoutContext } from '../from_orchestrator/tools/scout.ts';

function paths(result: ReturnType<typeof discoverScoutContext>): string[] {
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
    include_reverse_importers: false
  });

  const selected = paths(result);
  assert.ok(selected.includes('from_orchestrator/mcp/contextValidation.ts'));
  assert.ok(selected.includes('tests/contextValidation.test.ts'));
  assert.ok(selected.includes('package.json'));
  assert.ok(selected.includes('tsconfig.json'));
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
