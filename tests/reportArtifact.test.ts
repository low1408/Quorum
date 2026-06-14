import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { saveCouncilReportArtifact } from '../from_orchestrator/mcp/reportArtifact.ts';

test('saveCouncilReportArtifact writes a Markdown council report under quorum', async () => {
  const artifact = await saveCouncilReportArtifact({
    run_id: 'council_run_test:unsafe/id',
    status: 'COMPLETED',
    report: '## Recommendation\n\nUse the small fix.',
    warnings: ['context was truncated']
  });

  assert.equal(artifact.relativePath, 'quorum/council_run_test_unsafe_id.md');

  const markdown = await fs.readFile(artifact.absolutePath, 'utf8');
  assert.match(markdown, /^# Council Report/);
  assert.match(markdown, /Run ID: council_run_test:unsafe\/id/);
  assert.match(markdown, /## Recommendation/);
  assert.match(markdown, /- context was truncated/);

  await fs.unlink(artifact.absolutePath);
});
