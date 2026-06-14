import assert from 'node:assert/strict';
import test from 'node:test';
import { getDB, initSchema } from '../from_orchestrator/db/database.ts';
import {
  runCouncilDebate,
  buildCouncilDebatePrompt,
  buildCouncilDecisionPrompt,
  buildCouncilDebateConsolidationPrompt
} from '../from_orchestrator/engine/councilDebate.ts';
import type { ValidatedCouncilContext } from '../from_orchestrator/mcp/contextValidation.ts';
import { validateCouncilContext } from '../from_orchestrator/mcp/contextValidation.ts';

test('debate prompts are built with correct sections and reviewer labels', () => {
  const context = validateCouncilContext({
    files: [{ path: 'virtual.ts', content: 'export const x = 1;' }]
  }, 'Review this file.');

  const turn = {
    taskId: 'task_1',
    provider: 'chatgpt',
    reviewerLabel: 'REVIEWER 1',
    phase: 'analysis' as const,
    round: 1,
    response: 'Initial analysis response.',
    inputTaskIds: []
  };

  const critiquePrompt = buildCouncilDebatePrompt({
    question: 'Review this file.',
    context,
    reviewerLabel: 'REVIEWER 2',
    phase: 'critique',
    round: 2,
    precedingSnapshot: [turn]
  });

  assert.match(critiquePrompt, /You are REVIEWER 2 in this council debate/);
  assert.match(critiquePrompt, /PRECEDING ROUND SNAPSHOT/);
  assert.match(critiquePrompt, /REVIEWER 1/);
  assert.match(critiquePrompt, /Initial analysis response/);
  assert.match(critiquePrompt, /INSTRUCTION FOR THIS ROUND \(CRITIQUE\)/);

  const decisionPrompt = buildCouncilDecisionPrompt({
    question: 'Review this file.',
    context,
    reviewerLabel: 'REVIEWER 1',
    precedingSnapshot: [turn]
  });

  assert.match(decisionPrompt, /You are REVIEWER 1/);
  assert.match(decisionPrompt, /Recommended Decision:/);
  assert.match(decisionPrompt, /Retained Findings:/);
  assert.match(decisionPrompt, /Rejected Findings:/);
  assert.match(decisionPrompt, /Unresolved Questions:/);
});

test('runCouncilDebate runs multiple rounds, records lineage and creates database records', async () => {
  initSchema();
  const context = validateCouncilContext({
    files: [{ path: 'virtual.ts', content: 'export const x = 1;' }]
  }, 'Review this file.');

  const runnerFactory = ({ runId, taskId, provider }: { runId: string; taskId: string; provider: string }) => ({
    async executeTask(prompt: string, _poolItem: any, options?: any) {
      getDB().prepare(`
        INSERT INTO Tasks (task_id, run_id, provider_name, prompt_payload, status, attempt_no)
        VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
      `).run(taskId, runId, provider, prompt, options?.attemptNo ?? 1);

      let response = `Mock response from ${provider} for task ${taskId}`;
      if (taskId.includes('consolidation')) {
        response = 'Mock consolidated report';
      }

      getDB().prepare(`
        UPDATE Tasks
        SET response_text = ?, extraction_method = 'api', status = 'COMPLETED'
        WHERE task_id = ?
      `).run(response, taskId);

      return response;
    },
    async close() {}
  });

  const result = await runCouncilDebate({
    question: 'Review this file.',
    context,
    providers: ['chatgpt', 'gemini'],
    debateRoundsCount: 2, // Analysis (r1) -> Critique (r2) -> Rebuttal (r3) -> Decision (r4) -> Consolidation
    runnerFactory
  });

  assert.equal(result.status, 'COMPLETED');
  assert.match(result.run_id, /^council_debate_run_/);
  assert.equal(result.report, 'Mock consolidated report');

  // Verify Tasks table
  const dbTasks = getDB().prepare('SELECT task_id, status FROM Tasks WHERE run_id = ?').all(result.run_id) as any[];
  // Expected tasks:
  // Round 1 (Analysis): 2 tasks (chatgpt, gemini)
  // Round 2 (Critique): 2 tasks (chatgpt, gemini)
  // Round 3 (Rebuttal): 2 tasks (chatgpt, gemini)
  // Round 4 (Decision): 2 tasks (chatgpt, gemini)
  // Consolidation: 1 task
  // Total: 9 tasks
  assert.equal(dbTasks.length, 9);
  for (const t of dbTasks) {
    assert.equal(t.status, 'COMPLETED');
  }

  // Verify Lineage table
  const lineage = getDB().prepare(`
    SELECT parent_task_id, child_task_id
    FROM Lineage
    WHERE child_task_id LIKE ? OR parent_task_id LIKE ?
  `).all(`%${result.run_id}%`, `%${result.run_id}%`) as any[];

  // Let's assert lineage records exist.
  // 1. From Round 1 to Round 2:
  //    child_task_id for Round 2 should have parents from Round 1.
  const r2Tasks = lineage.filter(l => l.child_task_id.includes('_r2_'));
  assert.ok(r2Tasks.length > 0);
  // 2. From Round 4 to consolidation:
  const consolidationLinks = lineage.filter(l => l.child_task_id.includes('_consolidation'));
  assert.ok(consolidationLinks.length > 0);
});

test('runCouncilDebate supports partial success and handles eliminations when a provider fails', async () => {
  initSchema();
  const context = validateCouncilContext({
    files: [{ path: 'virtual.ts', content: 'export const x = 1;' }]
  }, 'Review this file.');

  const runnerFactory = ({ runId, taskId, provider }: { runId: string; taskId: string; provider: string }) => ({
    async executeTask(prompt: string, _poolItem: any, options?: any) {
      getDB().prepare(`
        INSERT INTO Tasks (task_id, run_id, provider_name, prompt_payload, status, attempt_no)
        VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
      `).run(taskId, runId, provider, prompt, options?.attemptNo ?? 1);

      // Make gemini fail on round 2 (critique)
      if (provider === 'gemini' && taskId.includes('_r2_')) {
        getDB().prepare(`
          UPDATE Tasks
          SET status = 'FAILED', failure_code = 'MOCK_ERROR'
          WHERE task_id = ?
        `).run(taskId);
        throw new Error('Gemini failed on Round 2');
      }

      let response = `Mock response from ${provider} for task ${taskId}`;
      if (taskId.includes('consolidation')) {
        response = 'Mock consolidated report';
      }

      getDB().prepare(`
        UPDATE Tasks
        SET response_text = ?, extraction_method = 'api', status = 'COMPLETED'
        WHERE task_id = ?
      `).run(response, taskId);

      return response;
    },
    async close() {}
  });

  const result = await runCouncilDebate({
    question: 'Review this file.',
    context,
    providers: ['chatgpt', 'gemini'],
    debateRoundsCount: 2,
    runnerFactory,
    maxRetries: 0
  });

  // Since gemini failed in round 2 but chatgpt completed the entire debate,
  // the run should complete with status PARTIAL_SUCCESS.
  assert.equal(result.status, 'PARTIAL_SUCCESS');
  assert.ok(result.warnings.some(w => w.includes('gemini failed') || w.includes('Gemini failed') || w.includes('eliminated')));

  // Verify Tasks table
  const dbTasks = getDB().prepare('SELECT task_id, provider_name, status FROM Tasks WHERE run_id = ?').all(result.run_id) as any[];
  // Expected tasks:
  // Round 1 (Analysis): 2 tasks (chatgpt: completed, gemini: completed)
  // Round 2 (Critique): 2 tasks (chatgpt: completed, gemini: failed)
  // Round 3 (Rebuttal): 1 task (chatgpt: completed, gemini: eliminated/not run)
  // Round 4 (Decision): 1 task (chatgpt: completed, gemini: eliminated/not run)
  // Consolidation: 1 task (chatgpt: completed)
  // Total tasks: 7 tasks
  assert.equal(dbTasks.length, 7);

  const geminiTasks = dbTasks.filter(t => t.provider_name === 'gemini');
  assert.equal(geminiTasks.length, 2); // only ran in Round 1 and Round 2
  const failedGemini = geminiTasks.find(t => t.status === 'FAILED');
  assert.ok(failedGemini);
});

test('runCouncilDebate fails if all providers fail during analysis', async () => {
  initSchema();
  const context = validateCouncilContext({
    files: [{ path: 'virtual.ts', content: 'export const x = 1;' }]
  }, 'Review this file.');

  const runnerFactory = ({ runId, taskId, provider }: { runId: string; taskId: string; provider: string }) => ({
    async executeTask(prompt: string, _poolItem: any, options?: any) {
      getDB().prepare(`
        INSERT INTO Tasks (task_id, run_id, provider_name, prompt_payload, status, attempt_no)
        VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
      `).run(taskId, runId, provider, prompt, options?.attemptNo ?? 1);

      getDB().prepare(`
        UPDATE Tasks
        SET status = 'FAILED', failure_code = 'MOCK_ERROR'
        WHERE task_id = ?
      `).run(taskId);
      throw new Error('All providers fail');
    },
    async close() {}
  });

  await assert.rejects(
    runCouncilDebate({
      question: 'Review this file.',
      context,
      providers: ['chatgpt', 'gemini'],
      runnerFactory,
      maxRetries: 0
    }),
    /All council members failed during the analysis round/
  );
});
