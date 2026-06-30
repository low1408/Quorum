import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Page, Response } from 'playwright';
import {
  ConversationResponseTracker,
  waitForAbortablePageTimeout
} from '../from_orchestrator/adapters/browserLifecycle.ts';

function response(url: string, method = 'POST'): Response {
  return {
    url: () => url,
    request: () => ({ method: () => method })
  } as unknown as Response;
}

test('conversation response tracker detaches listeners after a match and on rearm', async () => {
  const firstPage = new EventEmitter();
  const secondPage = new EventEmitter();
  const tracker = new ConversationResponseTracker();

  tracker.arm(firstPage as unknown as Page, '/conversation');
  assert.equal(firstPage.listenerCount('response'), 1);

  const activeResponse = tracker.arm(secondPage as unknown as Page, '/conversation');
  assert.equal(firstPage.listenerCount('response'), 0);
  assert.equal(secondPage.listenerCount('response'), 1);

  secondPage.emit('response', response('https://example.test/unrelated'));
  assert.equal(secondPage.listenerCount('response'), 1);
  const matchedResponse = response('https://example.test/conversation/123');
  secondPage.emit('response', matchedResponse);

  assert.ok(activeResponse);
  assert.equal(await activeResponse, matchedResponse);
  assert.equal(secondPage.listenerCount('response'), 0);
});

test('abortable page timeout removes its abort listener after the page delay wins', async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener: () => { added++; },
    removeEventListener: () => { removed++; }
  } as unknown as AbortSignal;
  const page = { waitForTimeout: async () => {} } as Pick<Page, 'waitForTimeout'>;

  await waitForAbortablePageTimeout(page, 1, signal);

  assert.equal(added, 1);
  assert.equal(removed, 1);
});
