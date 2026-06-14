import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { saveCouncilReportArtifact } from '../from_orchestrator/mcp/reportArtifact.ts';

test('saveCouncilReportArtifact writes per-run folder with individual member files', async () => {
  const runId = 'council_run_test:unsafe/id';
  const safeId = 'council_run_test_unsafe_id';

  const artifact = await saveCouncilReportArtifact({
    run_id: runId,
    status: 'COMPLETED',
    report: '## Council Member 1\n\nUse the small fix.',
    warnings: ['context was truncated'],
    analyses: [
      { provider: 'chatgpt', taskId: 'task_1', response: 'ChatGPT says: use option A.' },
      { provider: 'gemini', taskId: 'task_2', response: 'Gemini says: use option B.' }
    ]
  });

  // Combined report lives inside the run folder
  assert.equal(artifact.relativePath, `quorum/${safeId}/council_report.md`);

  const markdown = await fs.readFile(artifact.absolutePath, 'utf8');
  assert.match(markdown, /^# Council Report/);
  assert.match(markdown, new RegExp(`Run ID: ${runId.replace(/[/]/g, '\\/')}`));
  assert.match(markdown, /- context was truncated/);

  // Individual member files
  assert.equal(artifact.memberPaths.length, 2);
  assert.equal(artifact.memberPaths[0].provider, 'chatgpt');
  assert.equal(artifact.memberPaths[0].relativePath, `quorum/${safeId}/chatgpt.md`);
  assert.equal(artifact.memberPaths[1].provider, 'gemini');
  assert.equal(artifact.memberPaths[1].relativePath, `quorum/${safeId}/gemini.md`);

  const chatgptMd = await fs.readFile(artifact.memberPaths[0].absolutePath, 'utf8');
  assert.match(chatgptMd, /# Council Member Report — chatgpt/);
  assert.match(chatgptMd, /ChatGPT says: use option A\./);

  const geminiMd = await fs.readFile(artifact.memberPaths[1].absolutePath, 'utf8');
  assert.match(geminiMd, /# Council Member Report — gemini/);
  assert.match(geminiMd, /Gemini says: use option B\./);

  // Clean up the whole run folder
  const runFolder = path.dirname(artifact.absolutePath);
  await fs.rm(runFolder, { recursive: true, force: true });
});

test('saveCouncilReportArtifact handles empty analyses array gracefully', async () => {
  const runId = 'council_run_empty_analyses';

  const artifact = await saveCouncilReportArtifact({
    run_id: runId,
    status: 'PARTIAL_SUCCESS',
    report: '## Council Member 1\n\nNo members responded.',
    warnings: ['all providers timed out'],
    analyses: []
  });

  assert.equal(artifact.relativePath, `quorum/${runId}/council_report.md`);
  assert.equal(artifact.memberPaths.length, 0);

  const runFolder = path.dirname(artifact.absolutePath);
  await fs.rm(runFolder, { recursive: true, force: true });
});
