import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../from_orchestrator/config/index.ts';
import { validateCouncilContext } from '../from_orchestrator/mcp/contextValidation.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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
