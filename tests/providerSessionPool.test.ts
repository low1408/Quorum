import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  ProviderSessionPool,
  closeSessionItem,
  type SessionPoolItem
} from '../from_orchestrator/engine/providerSessionPool.ts';

function resources() {
  const closed: string[] = [];
  const page = {
    isClosed: () => false,
    close: async () => { closed.push('page'); }
  } as unknown as Page;
  const context = {
    close: async () => { closed.push('context'); }
  } as unknown as BrowserContext;
  const browser = {
    close: async () => { closed.push('browser'); }
  } as unknown as Browser;
  return { page, context, browser, closed };
}

test('session cleanup closes owned resources and clears references', async () => {
  const owned = resources();
  const item: SessionPoolItem = {
    ...owned,
    hasActiveThread: true,
    ownsPage: true,
    ownsContext: true,
    ownsBrowser: true
  };

  await closeSessionItem(item, 'test cleanup');

  assert.deepEqual(owned.closed, ['page', 'context', 'browser']);
  assert.equal(item.page, null);
  assert.equal(item.context, null);
  assert.equal(item.browser, null);
  assert.equal(item.hasActiveThread, false);
});

test('session cleanup preserves borrowed and external CDP resources', async () => {
  const borrowed = resources();
  await closeSessionItem({
    ...borrowed,
    hasActiveThread: true,
    isCdp: true,
    ownsPage: false,
    ownsContext: false,
    ownsBrowser: true
  });

  assert.deepEqual(borrowed.closed, []);
});

test('pool invalidation closes and removes an owned provider session', async () => {
  const pool = new ProviderSessionPool();
  const owned = resources();
  Object.assign(pool.acquire('provider'), owned, {
    ownsPage: true,
    ownsContext: true,
    ownsBrowser: true
  });

  await pool.invalidate('provider', 'failed attempt');

  assert.equal(pool.get('provider'), undefined);
  assert.deepEqual(owned.closed, ['page', 'context', 'browser']);
});
