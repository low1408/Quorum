import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { normalizeCdpEndpoint, resolveWorkspaceRoot, shouldLaunchHeadless } from '../from_orchestrator/config/index.ts';

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
