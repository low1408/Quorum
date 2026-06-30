import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserAdapter } from '../from_orchestrator/adapters/base.ts';
import {
  ProviderRegistry,
  createDefaultProviderRegistry
} from '../from_orchestrator/adapters/registry.ts';

function adapter(providerId: string): BrowserAdapter {
  return { providerId } as BrowserAdapter;
}

test('provider registries support normalized extension without changing core maps', () => {
  const registry = new ProviderRegistry();
  registry.register(' Custom-Provider ', () => adapter('custom-provider'));

  assert.deepEqual(registry.ids(), ['custom-provider']);
  assert.equal(registry.has('CUSTOM-PROVIDER'), true);
  assert.equal(registry.create(' custom-provider ').providerId, 'custom-provider');
  assert.deepEqual(registry.validate([' CUSTOM-PROVIDER ']), ['custom-provider']);
});

test('provider registries reject accidental replacement and report instance IDs', () => {
  const registry = new ProviderRegistry([['first', () => adapter('first')]]);

  assert.throws(() => registry.register('FIRST', () => adapter('replacement')), /already registered/);
  assert.throws(() => registry.create('missing'), /Supported providers: first/);
  registry.register('first', () => adapter('replacement'), { replace: true });
  assert.equal(registry.create('first').providerId, 'replacement');
});

test('default registry construction controls internal providers explicitly', () => {
  assert.equal(createDefaultProviderRegistry({ includeInternal: false }).has('mock'), false);
  assert.equal(createDefaultProviderRegistry({ includeInternal: true }).has('mock'), true);
});
