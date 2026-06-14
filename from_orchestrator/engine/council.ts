import crypto from 'crypto';
import { DBService } from '../db/database.ts';
import { OrchestrationRunner, type SessionPoolItem } from './runner.ts';
import type { ValidatedCouncilContext } from '../mcp/contextValidation.ts';

export type CouncilConsultationRequest = {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
  providers?: string[];
  maxWaitMs?: number;
};

export type CouncilConsultationResult = {
  run_id: string;
  status: 'COMPLETED' | 'PARTIAL_SUCCESS';
  report: string;
  warnings: string[];
};

type CouncilAnalysis = {
  provider: string;
  taskId: string;
  response: string;
};

const DEFAULT_PROVIDERS = (process.env.COUNCIL_PROVIDERS || 'chatgpt,gemini,claude')
  .split(',')
  .map(provider => provider.trim())
  .filter(Boolean);

function uniqueProviders(providers?: string[]): string[] {
  const selected = providers?.length ? providers : DEFAULT_PROVIDERS;
  return Array.from(new Set(selected.map(provider => provider.trim()).filter(Boolean)));
}

function anonymizedSourceLabel(index: number): string {
  return `ANALYSIS ${index + 1}`;
}

export function buildCouncilAnalysisPrompt(params: {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
}): string {
  const contextBlocks = params.context.files.map(file =>
    `--- FILE: ${file.normalizedPath} ---\n${file.content}`
  ).join('\n\n');

  return [
    'You are one independent reviewer in a private council advising a coding agent.',
    'Analyze the request and repository context independently. Do not write final code.',
    'Return practical implementation options, risks, missing context, and tests. Be specific and concise.',
    'Do not mention model names, provider identity, or the existence of other council members.',
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    params.context.notes ? `CALLER CONTEXT NOTES:\n${params.context.notes}` : '',
    `REPOSITORY CONTEXT:\n${contextBlocks}`
  ].filter(Boolean).join('\n\n');
}

export function buildCouncilConsolidationPrompt(params: {
  question: string;
  analyses: CouncilAnalysis[];
  constraints?: string;
}): string {
  const analysisBlocks = params.analyses.map((analysis, index) =>
    `--- ${anonymizedSourceLabel(index)} ---\n${analysis.response}`
  ).join('\n\n');

  return [
    'You are consolidating independent council analyses for a coding agent.',
    'Produce one anonymous, action-oriented Markdown report. Do not include provider names, model names, votes, or attribution.',
    'Do not tell the agent to review individual analyses. Present final options the coding agent can act on.',
    'Use exactly these top-level section headings: Recommendation, Options, Risks, Implementation Notes, Tests, Open Questions.',
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    `INDEPENDENT ANALYSES:\n${analysisBlocks}`
  ].filter(Boolean).join('\n\n');
}

function withTimeout<T>(promise: Promise<T>, maxWaitMs: number, runId: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      const err = new Error(`consult_council timed out after ${maxWaitMs}ms for run ${runId}.`);
      (err as any).code = 'TIMEOUT';
      (err as any).run_id = runId;
      reject(err);
    }, maxWaitMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function newPoolItem(): SessionPoolItem {
  return { browser: null, context: null, page: null, hasActiveThread: false };
}

async function runCouncilConsultationInner(request: CouncilConsultationRequest, runId: string): Promise<CouncilConsultationResult> {
  const providers = uniqueProviders(request.providers);
  if (providers.length === 0) {
    throw new Error('At least one council provider is required.');
  }

  DBService.createRun(runId, request.question.substring(0, 100));
  const prompt = buildCouncilAnalysisPrompt({
    question: request.question,
    context: request.context,
    constraints: request.constraints
  });

  const pagePool: Record<string, SessionPoolItem> = {};
  const analysisResults = await Promise.allSettled(providers.map(async (provider, index): Promise<CouncilAnalysis> => {
    pagePool[provider] = pagePool[provider] || newPoolItem();
    const taskId = `council_${runId}_${index + 1}_${provider}`;
    const runner = new OrchestrationRunner(runId, taskId, provider, { manageRunStatus: false });
    const response = await runner.executeTask(prompt, pagePool[provider]);
    pagePool[provider].hasActiveThread = true;
    return { provider, taskId, response };
  }));

  const analyses: CouncilAnalysis[] = [];
  const warnings = [...request.context.warnings];
  for (const result of analysisResults) {
    if (result.status === 'fulfilled') {
      analyses.push(result.value);
    } else {
      warnings.push(`A council member failed and was omitted from consolidation: ${result.reason?.message || String(result.reason)}`);
    }
  }

  if (analyses.length === 0) {
    DBService.updateRunStatus(runId, 'FAILED');
    throw new Error(`All council members failed for run ${runId}.`);
  }

  const consolidatorProvider = providers.includes('mock') ? 'mock' : (process.env.COUNCIL_CONSOLIDATOR_PROVIDER || providers[0]);
  const consolidationTaskId = `council_${runId}_consolidation`;
  const consolidationPrompt = buildCouncilConsolidationPrompt({
    question: request.question,
    analyses,
    constraints: request.constraints
  });

  const runner = new OrchestrationRunner(runId, consolidationTaskId, consolidatorProvider, { manageRunStatus: false });
  const report = await runner.executeTask(consolidationPrompt, pagePool[consolidatorProvider] || newPoolItem());

  for (const analysis of analyses) {
    DBService.addLineage(analysis.taskId, consolidationTaskId);
  }

  const status = analyses.length === providers.length ? 'COMPLETED' : 'PARTIAL_SUCCESS';
  DBService.updateRunStatus(runId, status);

  return {
    run_id: runId,
    status,
    report,
    warnings: Array.from(new Set(warnings))
  };
}

export async function runCouncilConsultation(request: CouncilConsultationRequest): Promise<CouncilConsultationResult> {
  const runId = `council_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const maxWaitMs = request.maxWaitMs && request.maxWaitMs > 0 ? request.maxWaitMs : 10 * 60 * 1000;

  try {
    return await withTimeout(runCouncilConsultationInner(request, runId), maxWaitMs, runId);
  } catch (err: any) {
    if (err?.code === 'INTERVENTION_REQUIRED') {
      err.run_id = runId;
      DBService.updateRunStatus(runId, 'INTERVENTION_REQUIRED');
    } else {
      DBService.updateRunStatus(runId, 'FAILED');
    }
    throw err;
  }
}
