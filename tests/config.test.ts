import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createRuntimeConfig,
  normalizeCdpEndpoint,
  requireEncryptionKey,
  resolveWorkspaceRoot,
  shouldLaunchHeadless
} from '../from_orchestrator/config/index.ts';

test('normalizes shorthand CDP endpoints into Playwright URLs', () => {
  assert.equal(normalizeCdpEndpoint('9222'), 'http://127.0.0.1:9222');
  assert.equal(normalizeCdpEndpoint('127.0.0.1:9223'), 'http://127.0.0.1:9223');
  assert.equal(normalizeCdpEndpoint('http://localhost:9224'), 'http://localhost:9224');
});

test('forces headless launch on Linux when no display server is available', () => {
  assert.equal(shouldLaunchHeadless('false', {}, 'linux'), true);
  assert.equal(shouldLaunchHeadless('false', { DISPLAY: ':0' }, 'linux'), false);
  assert.equal(shouldLaunchHeadless('false', {}, 'darwin'), false);
});

test('resolves workspace root from explicit override or repository location', () => {
  assert.equal(resolveWorkspaceRoot('/tmp/example-workspace'), '/tmp/example-workspace');
  assert.equal(resolveWorkspaceRoot(undefined), path.resolve(process.cwd()));
});

test('requires an explicit encryption key with sufficient length', () => {
  assert.throws(() => requireEncryptionKey(undefined), /ENCRYPTION_KEY is required/);
  assert.throws(() => requireEncryptionKey('short'), /at least 32 characters/);

  const key = 'a-private-session-key-that-is-long-enough';
  assert.equal(requireEncryptionKey(`  ${key}  `), key);
});

test('builds immutable runtime config from an explicit environment', () => {
  const runtime = createRuntimeConfig({
    COUNCIL_WORKSPACE_ROOT: '/tmp/quorum-workspace',
    DATABASE_PATH: 'data/council.db',
    CDP_ENDPOINT: '9222',
    HEADLESS: 'false',
    DISPLAY: ':0',
    HUMAN_TYPING: 'false',
    SYNERGIZER_PROVIDER: 'claude',
    REQUIRE_STRUCTURED_REVIEW_CONTEXT: 'true'
  }, 'linux');

  assert.equal(runtime.rootDir, '/tmp/quorum-workspace');
  assert.equal(runtime.databasePath, '/tmp/quorum-workspace/data/council.db');
  assert.equal(runtime.cdpEndpoint, 'http://127.0.0.1:9222');
  assert.equal(runtime.headless, false);
  assert.equal(runtime.humanTyping, false);
  assert.equal(runtime.synergizerProvider, 'claude');
  assert.equal(runtime.requireStructuredReviewContext, true);
  assert.equal(Object.isFrozen(runtime), true);
});
