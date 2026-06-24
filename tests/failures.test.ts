import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure } from '../from_orchestrator/engine/failures.ts';

test('classifies headed Chromium without a display as browser launch failure', () => {
  const failure = classifyFailure(new Error([
    'browserType.launch: Target page, context or browser has been closed',
    'Looks like you launched a headed browser without having a XServer running.',
    'Missing X server or $DISPLAY',
    'The platform failed to initialize.'
  ].join('\n')));

  assert.equal(failure.code, 'BROWSER_LAUNCH');
  assert.equal(failure.retryable, false);
});
