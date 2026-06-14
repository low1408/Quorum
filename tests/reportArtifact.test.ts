import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { saveCouncilReportArtifact } from '../from_orchestrator/mcp/reportArtifact.ts';

async function snapshotFile(filePath: string): Promise<string | null> {
  return await fs.readFile(filePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

async function restoreFile(filePath: string, content: string | null): Promise<void> {
  if (content === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, content, 'utf8');
}

test('saveCouncilReportArtifact writes direct quorum folder with individual member files', async () => {
  const runId = 'council_run_test:unsafe/id';
  const safeRunId = 'council_run_test_unsafe_id';
  const outputPaths = [
    'quorum/council_report.md',
    `quorum/test-chatgpt_${safeRunId}.md`,
    `quorum/test-gemini_${safeRunId}.md`
  ];
  const snapshots = await Promise.all(outputPaths.map(snapshotFile));

  try {
    const artifact = await saveCouncilReportArtifact({
      run_id: runId,
      status: 'COMPLETED',
      report: '## Council Member 1\n\nUse the small fix.',
      warnings: ['context was truncated'],
      analyses: [
        { provider: 'test-chatgpt', taskId: 'task_1', response: 'ChatGPT says: use option A.' },
        { provider: 'test-gemini', taskId: 'task_2', response: 'Gemini says: use option B.' }
      ]
    });

    // Combined report lives in the local quorum folder
    assert.equal(artifact.relativePath, 'quorum/council_report.md');

    const markdown = await fs.readFile(artifact.absolutePath, 'utf8');
    assert.match(markdown, /^# Council Report/);
    assert.match(markdown, new RegExp(`Run ID: ${runId.replace(/[/]/g, '\\/')}`));
    assert.match(markdown, /- context was truncated/);

    // Individual member files
    assert.equal(artifact.memberPaths.length, 2);
    assert.equal(artifact.memberPaths[0].provider, 'test-chatgpt');
    assert.equal(artifact.memberPaths[0].relativePath, `quorum/test-chatgpt_${safeRunId}.md`);
    assert.equal(artifact.memberPaths[1].provider, 'test-gemini');
    assert.equal(artifact.memberPaths[1].relativePath, `quorum/test-gemini_${safeRunId}.md`);

    const chatgptMd = await fs.readFile(artifact.memberPaths[0].absolutePath, 'utf8');
    assert.match(chatgptMd, /# Council Member Report — test-chatgpt/);
    assert.match(chatgptMd, /ChatGPT says: use option A\./);

    const geminiMd = await fs.readFile(artifact.memberPaths[1].absolutePath, 'utf8');
    assert.match(geminiMd, /# Council Member Report — test-gemini/);
    assert.match(geminiMd, /Gemini says: use option B\./);
  } finally {
    await Promise.all(outputPaths.map((filePath, index) => restoreFile(filePath, snapshots[index])));
  }
});

test('saveCouncilReportArtifact handles empty analyses array gracefully', async () => {
  const runId = 'council_run_empty_analyses';
  const reportPath = 'quorum/council_report.md';
  const snapshot = await snapshotFile(reportPath);

  try {
    const artifact = await saveCouncilReportArtifact({
      run_id: runId,
      status: 'PARTIAL_SUCCESS',
      report: '## Council Member 1\n\nNo members responded.',
      warnings: ['all providers timed out'],
      analyses: []
    });

    assert.equal(artifact.relativePath, 'quorum/council_report.md');
    assert.equal(artifact.memberPaths.length, 0);
  } finally {
    await restoreFile(reportPath, snapshot);
  }
});
