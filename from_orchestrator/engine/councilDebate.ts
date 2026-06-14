import crypto from 'node:crypto';
import { DBService } from '../db/database.ts';
import { OrchestrationRunner } from './runner.ts';

import { validateCouncilRequestText } from '../mcp/contextValidation.ts';
import type { ValidatedCouncilContext } from '../mcp/contextValidation.ts';
import type { CouncilConsultationRequest, CouncilConsultationResult } from './council.ts';
import { validateProviderList, normalizeProviderId } from '../adapters/registry.ts';
import { closeSessionItem, ProviderSessionPool, type SessionPoolItem } from './providerSessionPool.ts';
import { createCancelledError, isAbortError } from './statuses.ts';
import { classifyFailure } from './failures.ts';
import type { FailureClassification } from './failures.ts';
import {
  uniqueProviders,
  trustBoundaryInstruction,
  reviewerContract,
  renderContextWarnings,
  renderRepositoryEvidence,
  providerTimeoutMs,
  maxConcurrency,
  maxRetries,
  retryBackoffMs,
  delay,
  mapWithConcurrency,
  timeoutSignal,
  createFreshProviderSession,
  buildCouncilAnalysisPrompt
} from './council.ts';

export type CouncilDebateTurn = {
  taskId: string;
  provider: string;      // Internal only
  reviewerLabel: string; // REVIEWER 1, REVIEWER 2, etc.
  phase: 'analysis' | 'critique' | 'rebuttal' | 'decision';
  round: number;
  response: string;
  inputTaskIds: string[];
};


export interface CouncilDebateRequest extends CouncilConsultationRequest {
  debateRoundsCount?: number;
}

function acquireConsolidationSession(pool: ProviderSessionPool, provider: string): {
  session: SessionPoolItem;
  transient: boolean;
} {
  const existing = pool.get(provider);
  if (existing && !existing.invalidated && (existing.browser || existing.context || existing.page)) {
    return {
      session: createFreshProviderSession(existing),
      transient: true
    };
  }
  return {
    session: pool.acquire(provider),
    transient: false
  };
}

/**
 * Builds the critique/rebuttal prompt for a specific reviewer.
 * Self-contained: includes the question, constraints, repository evidence, warnings,
 * and the preceding round snapshot.
 */
export function buildCouncilDebatePrompt(params: {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
  reviewerLabel: string;
  phase: 'critique' | 'rebuttal';
  round: number;
  precedingSnapshot: CouncilDebateTurn[];
}): string {
  const snapshotText = params.precedingSnapshot
    .map(turn => `--- ${turn.reviewerLabel} ---\n${turn.response}`)
    .join('\n\n');

  const roleInstruction = `You are ${params.reviewerLabel} in this council debate.`;
  const phaseInstruction = params.phase === 'critique'
    ? `Analyze the preceding round's snapshot of findings from all council members. Critique their arguments, identify any incorrect claims, and revise your own analysis accordingly.`
    : `Provide your rebuttal to the critiques raised in the preceding round. Refine your arguments and defend or adjust your findings based on the repository evidence.`;

  const repositoryEvidence = renderRepositoryEvidence(params.context);
  const warnings = renderContextWarnings(params.context.warnings);

  return [
    `You are participating in a multi-round council debate advising a coding agent.`,
    roleInstruction,
    `Do not mention your model name, provider identity, or other model names. Refer to other members only by their reviewer labels (e.g., REVIEWER 1, REVIEWER 2).`,
    trustBoundaryInstruction(),
    reviewerContract(),
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    `REPOSITORY EVIDENCE:\n${repositoryEvidence}`,
    warnings,
    `PRECEDING ROUND SNAPSHOT:\n${snapshotText}`,
    '',
    `INSTRUCTION FOR THIS ROUND (${params.phase.toUpperCase()}):`,
    phaseInstruction,
    `Present your updated analysis in the required reviewer format.`
  ].filter(Boolean).join('\n\n');
}

/**
 * Builds the final decision prompt for a specific reviewer.
 * Requires stating recommended decision, retained findings, rejected findings, and unresolved questions.
 */
export function buildCouncilDecisionPrompt(params: {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
  reviewerLabel: string;
  precedingSnapshot: CouncilDebateTurn[];
}): string {
  const snapshotText = params.precedingSnapshot
    .map(turn => `--- ${turn.reviewerLabel} ---\n${turn.response}`)
    .join('\n\n');

  const repositoryEvidence = renderRepositoryEvidence(params.context);
  const warnings = renderContextWarnings(params.context.warnings);

  return [
    `You are participating in the final round of a council debate advising a coding agent.`,
    `You are ${params.reviewerLabel}.`,
    `Do not mention your model name, provider identity, or other model names. Refer to other members only by their reviewer labels (e.g., REVIEWER 1, REVIEWER 2).`,
    trustBoundaryInstruction(),
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    `REPOSITORY EVIDENCE:\n${repositoryEvidence}`,
    warnings,
    `PRECEDING ROUND SNAPSHOT:\n${snapshotText}`,
    '',
    `FINAL INSTRUCTION:`,
    `You must now state your final position. Format your response to explicitly include the following sections:`,
    `1. Recommended Decision: A clear, final recommendation on how the coding agent should proceed.`,
    `2. Retained Findings: The findings from earlier rounds that you still believe are valid and supported by exact repository evidence.`,
    `3. Rejected Findings: The findings (either your own or from other reviewers) that you have rejected after the debate, with reasons why.`,
    `4. Unresolved Questions: Any remaining uncertainties, missing context, or aspects that cannot be verified from the repository context.`
  ].filter(Boolean).join('\n\n');
}

/**
 * Builds the consolidation prompt for the debate.
 * Grouping transcript chronologically, directing consolidator to form Markdown report.
 */
export function buildCouncilDebateConsolidationPrompt(params: {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
  turns: CouncilDebateTurn[];
}): string {
  const rounds = Array.from(new Set(params.turns.map(t => t.round))).sort((a, b) => a - b);
  const transcript = rounds.map(r => {
    const roundTurns = params.turns.filter(t => t.round === r);
    const phase = roundTurns[0].phase.toUpperCase();
    const turnsText = roundTurns.map(t => `[${t.reviewerLabel}]:\n${t.response}`).join('\n\n');
    return `=== ROUND ${r} (${phase}) ===\n\n${turnsText}`;
  }).join('\n\n=========================================\n\n');

  const repositoryEvidence = renderRepositoryEvidence(params.context);
  const warnings = renderContextWarnings(params.context.warnings);

  return [
    'You are consolidating a multi-round council debate transcript for a coding agent.',
    'Produce one anonymous, action-oriented Markdown report. Do not include provider names, model names, votes, or attribution.',
    'Do not tell the agent to review individual analyses. Present final options the coding agent can act on.',
    'Use exactly these top-level section headings: Recommendation, Options, Risks, Implementation Notes, Tests, Open Questions.',
    'Consolidate the transcript based on repository evidence, not vote count. Retain only findings supported by exact repository evidence. Move unsupported claims, invented paths, invented symbols, and unverified test results to Open Questions.',
    'Do not reproduce sensitive-looking literals from analyses or evidence.',
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    `REPOSITORY EVIDENCE FOR VERIFICATION:\n${repositoryEvidence}`,
    warnings,
    `DEBATE TRANSCRIPT:\n${transcript}`
  ].filter(Boolean).join('\n\n');
}

/**
 * Executes a multi-round council debate orchestrator session.
 */
export async function runCouncilDebate(
  request: CouncilDebateRequest
): Promise<CouncilConsultationResult> {
  const runId = `council_debate_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  try {
    validateCouncilRequestText(request.question, request.constraints);
    const providers = uniqueProviders(request.providers);
    if (providers.length === 0) {
      throw new Error('At least one council provider is required.');
    }

    DBService.createRun(runId, request.question.substring(0, 100));
    DBService.updateRunStatusIfNotTerminal(runId, 'IN_PROGRESS');

    const result = await runCouncilDebateInner(request, runId, providers);
    return result;
  } catch (err: any) {
    if (err?.code === 'INTERVENTION_REQUIRED') {
      err.run_id = runId;
      DBService.updateRunStatusIfNotTerminal(runId, 'INTERVENTION_REQUIRED');
    } else if (isAbortError(err)) {
      err.run_id = runId;
      DBService.updateRunStatusIfNotTerminal(runId, 'CANCELLED');
    } else {
      DBService.updateRunStatusIfNotTerminal(runId, 'FAILED');
    }
    throw err;
  }
}

async function runCouncilDebateInner(
  request: CouncilDebateRequest,
  runId: string,
  providers: string[]
): Promise<CouncilConsultationResult> {
  const pool = new ProviderSessionPool();
  const perProviderTimeoutMsVal = providerTimeoutMs(request, providers.length);
  const concurrencyLimit = maxConcurrency(request);
  const retryLimit = maxRetries(request);

  // Assign stable reviewer labels
  const reviewerLabels = new Map<string, string>();
  providers.forEach((provider, index) => {
    reviewerLabels.set(provider, `REVIEWER ${index + 1}`);
  });

  const debateRoundsCount = request.debateRoundsCount ?? 2;
  const warnings = [...request.context.warnings];
  const turns: CouncilDebateTurn[] = [];

  let survivingProviders = [...providers];

  // Executes a single provider turn
  async function runProviderRound(params: {
    provider: string;
    round: number;
    phase: 'analysis' | 'critique' | 'rebuttal' | 'decision';
    prompt: string;
    inputTaskIds: string[];
    attemptNo: number;
  }): Promise<CouncilDebateTurn> {
    const { provider, round, phase, prompt, inputTaskIds, attemptNo } = params;
    const taskId = `council_debate_${runId}_r${round}_${provider}_attempt_${attemptNo}`;

    const runnerFactory = request.runnerFactory ?? (params => new OrchestrationRunner(params.runId, params.taskId, params.provider, { manageRunStatus: false }));
    const runner = runnerFactory({ runId, taskId, provider });
    const controller = timeoutSignal(perProviderTimeoutMsVal, `${provider} timed out after ${perProviderTimeoutMsVal}ms.`);

    try {
      const session = pool.acquire(provider);
      const response = await runner.executeTask(prompt, session, {
        signal: controller.signal,
        timeouts: { providerExecutionMs: perProviderTimeoutMsVal, ...request.timeouts },
        attemptNo
      });
      session.hasActiveThread = true;
      session.lastUsedAt = Date.now();

      // Record lineage link from every input turn actually supplied
      for (const inputTaskId of inputTaskIds) {
        DBService.addLineage(inputTaskId, taskId);
      }

      return {
        taskId,
        provider,
        reviewerLabel: reviewerLabels.get(provider)!,
        phase,
        round,
        response,
        inputTaskIds
      };
    } catch (err) {
      controller.abort(createCancelledError(`${provider} failed.`));
      await runner.close().catch(() => {});
      await pool.invalidate(provider, err instanceof Error ? err.message : String(err)).catch(() => {});
      throw err;
    }
  }

  // Executes single provider turn with retries
  async function runProviderRoundWithRetry(params: {
    provider: string;
    round: number;
    phase: 'analysis' | 'critique' | 'rebuttal' | 'decision';
    prompt: string;
    inputTaskIds: string[];
  }): Promise<CouncilDebateTurn> {
    let lastFailure: FailureClassification | null = null;

    for (let attemptNo = 1; attemptNo <= retryLimit + 1; attemptNo++) {
      try {
        return await runProviderRound({ ...params, attemptNo });
      } catch (err) {
        const failure = classifyFailure(err);
        lastFailure = failure;
        warnings.push(`${params.provider} round ${params.round} attempt ${attemptNo} failed: ${failure.publicMessage}`);

        if (!failure.retryable || attemptNo > retryLimit) {
          throw err;
        }

        await delay(retryBackoffMs(attemptNo));
      }
    }

    throw new Error(lastFailure?.message || `${params.provider} failed after retries.`);
  }

  // --- ROUND 1: Analysis ---
  console.log(`\n--- Council Debate Round 1: Analysis ---`);
  const analysisPrompt = buildCouncilAnalysisPrompt({
    question: request.question,
    context: request.context,
    constraints: request.constraints
  });

  const analysisResults = await mapWithConcurrency(survivingProviders, concurrencyLimit, async (provider) => {
    return await runProviderRoundWithRetry({
      provider,
      round: 1,
      phase: 'analysis',
      prompt: analysisPrompt,
      inputTaskIds: []
    });
  });

  let currentRoundTurns: CouncilDebateTurn[] = [];
  survivingProviders = [];
  analysisResults.forEach((result, idx) => {
    const provider = providers[idx];
    if (result.status === 'fulfilled') {
      turns.push(result.value);
      currentRoundTurns.push(result.value);
      survivingProviders.push(provider);
    } else {
      const reason = result.reason?.message || String(result.reason);
      warnings.push(`${reviewerLabels.get(provider)} failed in Round 1 (Analysis) and is eliminated: ${reason}`);
    }
  });

  if (survivingProviders.length === 0) {
    throw new Error('All council members failed during the analysis round.');
  }

  // --- DEBATE ROUNDS (Round 2 to Round N+1) ---
  for (let dRound = 1; dRound <= debateRoundsCount; dRound++) {
    const roundNumber = dRound + 1;
    const phase: 'critique' | 'rebuttal' = dRound === 1 ? 'critique' : 'rebuttal';
    console.log(`\n--- Council Debate Round ${roundNumber}: ${phase.toUpperCase()} ---`);

    const precedingSnapshot = [...currentRoundTurns];
    const precedingTaskIds = precedingSnapshot.map(t => t.taskId);

    const debateResults = await mapWithConcurrency(survivingProviders, concurrencyLimit, async (provider) => {
      const reviewerLabel = reviewerLabels.get(provider)!;
      const prompt = buildCouncilDebatePrompt({
        question: request.question,
        context: request.context,
        constraints: request.constraints,
        reviewerLabel,
        phase,
        round: roundNumber,
        precedingSnapshot
      });

      return await runProviderRoundWithRetry({
        provider,
        round: roundNumber,
        phase,
        prompt,
        inputTaskIds: precedingTaskIds
      });
    });

    currentRoundTurns = [];
    const roundSurvivingProviders: string[] = [];
    debateResults.forEach((result, idx) => {
      const provider = survivingProviders[idx];
      if (result.status === 'fulfilled') {
        turns.push(result.value);
        currentRoundTurns.push(result.value);
        roundSurvivingProviders.push(provider);
      } else {
        const reason = result.reason?.message || String(result.reason);
        warnings.push(`${reviewerLabels.get(provider)} failed in Round ${roundNumber} (${phase}) and is eliminated: ${reason}`);
      }
    });

    survivingProviders = roundSurvivingProviders;

    if (survivingProviders.length === 0) {
      throw new Error(`All surviving council members failed during Round ${roundNumber} (${phase}).`);
    }
  }

  // --- FINAL ROUND: Decision ---
  const finalRoundNumber = debateRoundsCount + 2;
  console.log(`\n--- Council Debate Round ${finalRoundNumber}: DECISION ---`);
  const precedingSnapshot = [...currentRoundTurns];
  const precedingTaskIds = precedingSnapshot.map(t => t.taskId);

  const decisionResults = await mapWithConcurrency(survivingProviders, concurrencyLimit, async (provider) => {
    const reviewerLabel = reviewerLabels.get(provider)!;
    const prompt = buildCouncilDecisionPrompt({
      question: request.question,
      context: request.context,
      constraints: request.constraints,
      reviewerLabel,
      precedingSnapshot
    });

    return await runProviderRoundWithRetry({
      provider,
      round: finalRoundNumber,
      phase: 'decision',
      prompt,
      inputTaskIds: precedingTaskIds
    });
  });

  currentRoundTurns = [];
  const finalSurvivingProviders: string[] = [];
  decisionResults.forEach((result, idx) => {
    const provider = survivingProviders[idx];
    if (result.status === 'fulfilled') {
      turns.push(result.value);
      currentRoundTurns.push(result.value);
      finalSurvivingProviders.push(provider);
    } else {
      const reason = result.reason?.message || String(result.reason);
      warnings.push(`${reviewerLabels.get(provider)} failed in final Round ${finalRoundNumber} (Decision) and is eliminated: ${reason}`);
    }
  });

  if (finalSurvivingProviders.length === 0) {
    throw new Error('All council members failed during the final decision round.');
  }

  // --- CONSOLIDATION ---
  console.log(`\n--- Council Debate: CONSOLIDATION ---`);
  const consolidatorProvider = normalizeProviderId(process.env.COUNCIL_CONSOLIDATOR_PROVIDER || finalSurvivingProviders[0]);
  validateProviderList([consolidatorProvider], 'consolidator provider');

  const consolidationTaskId = `council_debate_${runId}_consolidation`;
  const consolidationPrompt = buildCouncilDebateConsolidationPrompt({
    question: request.question,
    context: request.context,
    constraints: request.constraints,
    turns
  });

  const runnerFactory = request.runnerFactory ?? (params => new OrchestrationRunner(params.runId, params.taskId, params.provider, { manageRunStatus: false }));
  const runner = runnerFactory({ runId, taskId: consolidationTaskId, provider: consolidatorProvider });
  const consolidationTimeout = perProviderTimeoutMsVal;
  const controller = timeoutSignal(consolidationTimeout, `consolidation timed out after ${consolidationTimeout}ms.`);
  const consolidationSession = acquireConsolidationSession(pool, consolidatorProvider);
  let report: string;

  try {
    report = await runner.executeTask(consolidationPrompt, consolidationSession.session, {
      signal: controller.signal,
      timeouts: { providerExecutionMs: consolidationTimeout, ...request.timeouts },
      attemptNo: 1
    });
  } catch (err: any) {
    if (consolidationSession.transient) {
      await closeSessionItem(consolidationSession.session, err?.message || String(err)).catch(() => {});
    } else {
      await pool.invalidate(consolidatorProvider, err?.message || String(err)).catch(() => {});
    }
    throw new Error(`Council consolidation failed: ${err?.message || String(err)}`);
  } finally {
    controller.abort(createCancelledError('consolidation finished.'));
    await runner.close().catch(() => {});
    if (consolidationSession.transient) {
      await closeSessionItem(consolidationSession.session, 'council consolidation finished').catch(() => {});
    }
  }

  // Link all debate turns to the consolidation task
  for (const turn of turns) {
    DBService.addLineage(turn.taskId, consolidationTaskId);
  }

  const completedAllInitial = turns.filter(t => t.round === finalRoundNumber).length === providers.length;
  const status = completedAllInitial ? 'COMPLETED' : 'PARTIAL_SUCCESS';
  DBService.updateRunStatusIfNotTerminal(runId, status);

  return {
    run_id: runId,
    status,
    report,
    warnings: Array.from(new Set(warnings))
  };
}
