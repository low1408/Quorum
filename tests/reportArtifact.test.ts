import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveCouncilReportArtifact } from '../from_orchestrator/mcp/reportArtifact.ts';

async function makeWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'quorum-report-artifact-'));
}

test('saveCouncilReportArtifact writes run-scoped artifacts under current working directory', async () => {
  const workspaceRoot = await makeWorkspace();
  const originalCwd = process.cwd();
  const runId = 'council_run_test:unsafe/id';
  const safeRunId = 'council_run_test_unsafe_id';

  try {
    process.chdir(workspaceRoot);

    const artifact = await saveCouncilReportArtifact({
      run_id: runId,
      status: 'COMPLETED',
      report: '## Council Member 1\n\nUse small fix.',
      warnings: ['context was truncated'],
      analyses: [
        { provider: 'test-chatgpt', taskId: 'task_1', response: 'ChatGPT says: use option A.' },
        { provider: 'test-gemini', taskId: 'task_2', response: 'Gemini says: use option B.' }
      ]
    });

    assert.equal(artifact.relativePath, `quorum/${safeRunId}/council_report.md`);
    assert.equal(artifact.absolutePath, path.join(workspaceRoot, 'quorum', safeRunId, 'council_report.md'));

    const markdown = await fs.readFile(artifact.absolutePath, 'utf8');
    assert.match(markdown, /^# Council Report/);
    assert.match(markdown, new RegExp(`Run ID: ${runId.replace(/[/]/g, '\\/')}`));
    assert.match(markdown, /- context was truncated/);

    assert.equal(artifact.memberPaths.length, 2);
    assert.equal(artifact.memberPaths[0].provider, 'test-chatgpt');
    assert.equal(artifact.memberPaths[0].relativePath, `quorum/${safeRunId}/test-chatgpt.md`);
    assert.equal(artifact.memberPaths[0].absolutePath, path.join(workspaceRoot, 'quorum', safeRunId, 'test-chatgpt.md'));
    assert.equal(artifact.memberPaths[1].provider, 'test-gemini');
    assert.equal(artifact.memberPaths[1].relativePath, `quorum/${safeRunId}/test-gemini.md`);
    assert.equal(artifact.memberPaths[1].absolutePath, path.join(workspaceRoot, 'quorum', safeRunId, 'test-gemini.md'));

    const chatgptMd = await fs.readFile(artifact.memberPaths[0].absolutePath, 'utf8');
    assert.match(chatgptMd, /# Council Member Report — test-chatgpt/);
    assert.match(chatgptMd, /ChatGPT says: use option A\./);

    const geminiMd = await fs.readFile(artifact.memberPaths[1].absolutePath, 'utf8');
    assert.match(geminiMd, /# Council Member Report — test-gemini/);
    assert.match(geminiMd, /Gemini says: use option B\./);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('saveCouncilReportArtifact uses explicit workspace root when provided', async () => {
  const workspaceRoot = await makeWorkspace();
  const originalCwd = process.cwd();
  const runId = 'council_run_empty_analyses';

  try {
    process.chdir(os.tmpdir());

    const artifact = await saveCouncilReportArtifact(
      {
        run_id: runId,
        status: 'PARTIAL_SUCCESS',
        report: '## Council Member 1\n\nNo members responded.',
        warnings: ['all providers timed out'],
        analyses: []
      },
      { workspaceRoot }
    );

    assert.equal(artifact.relativePath, `quorum/${runId}/council_report.md`);
    assert.equal(artifact.absolutePath, path.join(workspaceRoot, 'quorum', runId, 'council_report.md'));
    assert.equal(artifact.memberPaths.length, 0);

    const markdown = await fs.readFile(artifact.absolutePath, 'utf8');
    assert.match(markdown, /No members responded\./);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
