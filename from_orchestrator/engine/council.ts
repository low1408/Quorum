import crypto from 'crypto';
import { OrchestrationRunner, type RunnerTimeoutBudgets } from './runner.ts';
import { validateCouncilRequestText, type ValidatedCouncilContext } from '../context/validation.ts';
import { validateProviderList, normalizeProviderId } from '../adapters/registry.ts';
import { ProviderSessionPool, type SessionPoolItem } from './providerSessionPool.ts';
import { createCancelledError, isAbortError } from './statuses.ts';
import { classifyFailure } from './failures.ts';
import {
  mapWithConcurrency,
  runProviderWithRetry,
  type ProviderTaskRunner,
  type ProviderTaskRunnerFactory
} from './providerExecution.ts';
import { sqlitePersistence, type TaskPersistence } from './persistence.ts';

export { mapWithConcurrency } from './providerExecution.ts';

export type CouncilConsultationRequest = {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
  providers?: string[];
  maxWaitMs?: number;
  providerTimeoutMs?: number;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  maxConcurrency?: number;
  maxRetries?: number;
  runnerFactory?: CouncilRunnerFactory;
  persistence?: TaskPersistence;
};

export type SynergizedCouncilRequest = CouncilConsultationRequest & {
  synthesizerProvider?: string;
  synthesisConstraints?: string;
};

export type CouncilConsultationResult = {
  run_id: string;
  status: 'COMPLETED' | 'PARTIAL_SUCCESS';
  report: string;
  warnings: string[];
  analyses: CouncilAnalysis[];
};

export type SynergizedCouncilResult = CouncilConsultationResult & {
  synthesis: CouncilAnalysis;
};

export type CouncilAnalysis = {
  provider: string;
  taskId: string;
  response: string;
};

export type CouncilRunner = ProviderTaskRunner;
export type CouncilRunnerFactory = ProviderTaskRunnerFactory;

export function defaultCouncilProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.COUNCIL_PROVIDERS || 'chatgpt,gemini,meta,kimi')
    .split(',')
    .map(provider => provider.trim())
    .filter(Boolean);
}

// Node timers are capped at a signed 32-bit integer. This is the longest
// practical timeout without triggering TimeoutOverflowWarning timer clamping.
export const EFFECTIVELY_INFINITE_TIMEOUT_MS = 2_147_483_647;

export function uniqueProviders(providers?: string[]): string[] {
  const selected = providers?.length ? providers : defaultCouncilProviders();
  return validateProviderList(selected.map(normalizeProviderId), 'council providers');
}

export function defaultSynergizerProvider(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const provider = env.SYNERGIZER_PROVIDER?.trim();
  return provider || undefined;
}

export function resolveSynergizerProvider(params: {
  explicitProvider?: string;
  successfulAnalyses: CouncilAnalysis[];
  env?: NodeJS.ProcessEnv;
}): string {
  const selected = params.explicitProvider?.trim()
    || defaultSynergizerProvider(params.env)
    || params.successfulAnalyses[0]?.provider;

  if (!selected) {
    throw new Error('A synthesizer provider is required when no council member succeeded.');
  }

  return validateProviderList([normalizeProviderId(selected)], 'synthesizer provider')[0];
}

export function createFreshProviderSession(source?: SessionPoolItem): SessionPoolItem {
  return {
    browser: source?.browser || null,
    context: source?.context || null,
    page: null,
    hasActiveThread: false,
    isCdp: source?.isCdp,
    ownsBrowser: source?.browser ? false : undefined,
    ownsContext: source?.context ? false : undefined,
    ownsPage: true,
    providerId: source?.providerId,
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  };
}

function lineNumberContent(content: string, startLine = 1): string {
  const lines = content.replace(/\s+$/u, '').split(/\r?\n/u);
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

export function renderContextWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return [
    'VALIDATION AND COMPLETENESS WARNINGS:',
    'Treat these as coverage limitations, not findings by themselves.',
    ...warnings.map(warning => `- ${warning}`)
  ].join('\n');
}

export function renderRepositoryEvidence(context: ValidatedCouncilContext): string {
  return context.files.map((file, index) => {
    const sourceNo = index + 1;
    const content = lineNumberContent(file.content, file.startLine);
    return [
      `<<<SOURCE ${sourceNo}`,
      `path=${file.normalizedPath}`,
      `role=${file.role}`,
      `provenance=${file.provenance}`,
      `relevance=${file.relevance || 'unspecified'}`,
      `excerpt=${file.isExcerpt}`,
      '>>>',
      content,
      `<<<END SOURCE ${sourceNo}>>>`
    ].join('\n');
  }).join('\n\n');
}

export function reviewerContract(): string {
  return [
    'REQUIRED REVIEWER FORMAT:',
    'Classify each finding as exactly one of: Confirmed defect, Likely defect, Architectural risk, Hardening recommendation, Unverifiable.',
    'For every finding include: severity, confidence, exact path:line evidence and code symbol (like a function name) , reasoning, missing context, and a validation test.',
    'Claims without exact supporting evidence from the supplied repository context must be classified as Unverifiable.',
    'Do not treat validation or completeness warnings as defects unless source evidence independently supports the finding.'
  ].join('\n');
}

export function buildCouncilAnalysisPrompt(params: {
  question: string;
  context: ValidatedCouncilContext;
  constraints?: string;
}): string {
  const structured = params.context.structured_review
    ? [
      `REVIEW OBJECTIVE:\n${params.context.structured_review.review_objective}`,
      `ARCHITECTURE:\n${params.context.structured_review.architecture}`,
      `EXECUTION FLOW:\n${params.context.structured_review.execution_flow}`,
      `ASSUMPTIONS AND INVARIANTS:\n${params.context.structured_review.assumptions_and_invariants}`,
      `CORE EVIDENCE:\n${params.context.structured_review.core_evidence}`,
      `SUPPORTING CONTRACTS:\n${params.context.structured_review.supporting_contracts}`,
      `PRIVACY AND PERSISTENCE:\n${params.context.structured_review.privacy_and_persistence}`,
      `TESTS AND RUNTIME EVIDENCE:\n${params.context.structured_review.tests_and_runtime_evidence}`,
      `OMITTED MATERIAL:\n${params.context.structured_review.omitted_material}`
    ].join('\n\n')
    : '';
  const warnings = renderContextWarnings(params.context.warnings);
  const repositoryEvidence = renderRepositoryEvidence(params.context);

  return [
    'You are one independent reviewer in a private council advising a coding agent.',
    'Analyze the request and repository context independently. Do not write final code.',
    'Return practical implementation options, risks, missing context, and tests. Be specific and concise.',
    reviewerContract(),
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `CONSTRAINTS:\n${params.constraints}` : '',
    params.context.notes ? `CALLER CONTEXT NOTES:\n${params.context.notes}` : '',
    structured ? `STRUCTURED REVIEW CONTEXT:\n${structured}` : '',
    warnings,
    `REPOSITORY EVIDENCE:\n${repositoryEvidence}`
  ].filter(Boolean).join('\n\n');
}

export function buildDirectReport(analyses: CouncilAnalysis[]): string {
  return analyses.map((analysis, index) =>
    `## Council Member ${index + 1}\n\n${analysis.response}`
  ).join('\n\n---\n\n');
}

export function buildCouncilSynthesisPrompt(params: {
  question: string;
  analyses: CouncilAnalysis[];
  warnings: string[];
  constraints?: string;
  synthesisConstraints?: string;
}): string {
  const warnings = renderContextWarnings(params.warnings);
  const memberOutputs = params.analyses.map((analysis, index) => [
    `<<<COUNCIL MEMBER ${index + 1}`,
    `provider=${analysis.provider}`,
    `task_id=${analysis.taskId}`,
    '>>>',
    analysis.response.trim(),
    `<<<END COUNCIL MEMBER ${index + 1}>>>`
  ].join('\n')).join('\n\n');

  return [
    'You are the synthesizer for a private multi-model council.',
    'Your job is to produce the best final answer by combining the strongest supported parts of each council member response.',
    'Do not average weak answers. Prefer the clearest explanation, best code, most concrete risks, and strongest tests from any member.',
    'Reject or qualify claims that are unsupported, contradictory, vague, or outside the supplied evidence.',
    'Write concise Markdown with exactly these top-level sections:',
    '## Synergized Answer',
    '## Best Contributions Used',
    '## Conflicts / Rejected Claims',
    '## Validation or Follow-up Tests',
    '',
    `QUESTION:\n${params.question}`,
    params.constraints ? `ORIGINAL CONSTRAINTS:\n${params.constraints}` : '',
    params.synthesisConstraints ? `SYNTHESIS CONSTRAINTS:\n${params.synthesisConstraints}` : '',
    warnings,
    `COUNCIL MEMBER OUTPUTS:\n${memberOutputs}`
  ].filter(Boolean).join('\n\n');
}

function normalizeTimeoutMs(ms: number, minimumMs = 1_000): number {
  return Math.min(EFFECTIVELY_INFINITE_TIMEOUT_MS, Math.max(minimumMs, Math.floor(ms)));
}

export function providerTimeoutMs(request: { providerTimeoutMs?: number; maxWaitMs?: number }, providerCount: number, minimumMs = 1_000): number {
  if (request.providerTimeoutMs && request.providerTimeoutMs > 0) return normalizeTimeoutMs(request.providerTimeoutMs, minimumMs);
  if (request.maxWaitMs && request.maxWaitMs > 0) return normalizeTimeoutMs(request.maxWaitMs, minimumMs);
  return normalizeTimeoutMs(EFFECTIVELY_INFINITE_TIMEOUT_MS, minimumMs);
}

export function maxConcurrency(request: { maxConcurrency?: number }): number {
  const raw = request.maxConcurrency ?? Number.parseInt(process.env.COUNCIL_MAX_CONCURRENCY || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 2;
}

export function maxRetries(request: { maxRetries?: number }): number {
  const raw = request.maxRetries ?? Number.parseInt(process.env.COUNCIL_MAX_RETRIES || '', 10);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 1;
}

function defaultRunnerFactory(persistence: TaskPersistence): CouncilRunnerFactory {
  return params => new OrchestrationRunner(params.runId, params.taskId, params.provider, {
    manageRunStatus: false,
    persistence
  });
}

function conciseFailureDetail(provider: string, reason: unknown): string {
  const failure = classifyFailure(reason);
  const rawMessage = reason instanceof Error ? reason.message : String(reason);
  const firstLine = rawMessage.split('\n').map(line => line.trim()).find(Boolean);
  return `${provider}: ${failure.code}${firstLine ? ` (${firstLine.slice(0, 180)})` : ''}`;
}

export function timeoutSignal(ms: number, message: string): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(createCancelledError(message)), normalizeTimeoutMs(ms)).unref();
  return controller;
}

type CouncilMemberCollection = {
  run_id: string;
  status: 'COMPLETED' | 'PARTIAL_SUCCESS';
  warnings: string[];
  analyses: CouncilAnalysis[];
  providers: string[];
  pool: ProviderSessionPool;
  perProviderTimeoutMs: number;
  runnerFactory: CouncilRunnerFactory;
  persistence: TaskPersistence;
};

async function collectCouncilAnalyses(request: CouncilConsultationRequest, runId: string): Promise<CouncilMemberCollection> {
  const persistence = request.persistence ?? sqlitePersistence;
  const providers = uniqueProviders(request.providers);
  if (providers.length === 0) {
    throw new Error('At least one council provider is required.');
  }

  persistence.createRun(runId, request.question.substring(0, 100));
  persistence.updateRunStatusIfNotTerminal(runId, 'IN_PROGRESS');
  const prompt = buildCouncilAnalysisPrompt({
    question: request.question,
    context: request.context,
    constraints: request.constraints
  });

  const pool = new ProviderSessionPool();
  const perProviderTimeoutMs = providerTimeoutMs(request, providers.length, EFFECTIVELY_INFINITE_TIMEOUT_MS);
  const concurrencyLimit = maxConcurrency(request);
  const retryLimit = maxRetries(request);
  const runnerFactory = request.runnerFactory ?? defaultRunnerFactory(persistence);
  const warnings = [...request.context.warnings];

  try {
    const analysisResults = await mapWithConcurrency(providers, concurrencyLimit, async (provider, index): Promise<CouncilAnalysis> => {
      return await runProviderWithRetry({
        provider,
        index,
        runId,
        prompt,
        taskPrefix: 'council',
        pool,
        timeoutMs: perProviderTimeoutMs,
        timeoutDefaults: {
          firstTokenMs: perProviderTimeoutMs,
          outputStabilizationMs: perProviderTimeoutMs
        },
        timeouts: request.timeouts,
        maxRetries: retryLimit,
        runnerFactory,
        warnings
      });
    });

    const analyses: CouncilAnalysis[] = [];
    const failedProviders: string[] = [];
    for (const result of analysisResults) {
      if (result.status === 'fulfilled') {
        analyses.push(result.value);
      } else {
        const provider = providers[failedProviders.length + analyses.length] ?? 'unknown';
        failedProviders.push(conciseFailureDetail(provider, result.reason));
        const reason = result.reason?.message || String(result.reason);
        warnings.push(`A council member failed, timed out, or was cancelled and was omitted from consolidation: ${reason}`);
      }
    }

    if (analyses.length === 0) {
      persistence.updateRunStatusIfNotTerminal(runId, 'FAILED');
      const suffix = failedProviders.length > 0 ? ` Failures: ${failedProviders.join('; ')}.` : '';
      throw new Error(`All council members failed for run ${runId}.${suffix}`);
    }

    const status = analyses.length === providers.length ? 'COMPLETED' : 'PARTIAL_SUCCESS';

    return {
      run_id: runId,
      status,
      warnings: Array.from(new Set(warnings)),
      analyses,
      providers,
      pool,
      perProviderTimeoutMs,
      runnerFactory,
      persistence
    };
  } catch (err: any) {
    err.run_id = runId;
    err.successfulProviderCount ??= 0;
    err.failedProviderCount ??= providers.length;
    throw err;
  }
}

async function runCouncilConsultationInner(request: CouncilConsultationRequest, runId: string): Promise<CouncilConsultationResult> {
  const collection = await collectCouncilAnalyses(request, runId);

  try {
    const report = buildDirectReport(collection.analyses);
    collection.persistence.updateRunStatusIfNotTerminal(runId, collection.status);

    return {
      run_id: runId,
      status: collection.status,
      report,
      warnings: collection.warnings,
      analyses: collection.analyses
    };
  } finally {
    // Keep browser sessions open after council consultation finished as requested by the user
    console.log('\n[INFO] Keeping active browser sessions open for visual inspection.\n');
  }
}

async function runSynergizedCouncilConsultationInner(request: SynergizedCouncilRequest, runId: string): Promise<SynergizedCouncilResult> {
  const collection = await collectCouncilAnalyses(request, runId);

  try {
    const synthesizerProvider = resolveSynergizerProvider({
      explicitProvider: request.synthesizerProvider,
      successfulAnalyses: collection.analyses
    });
    const prompt = buildCouncilSynthesisPrompt({
      question: request.question,
      constraints: request.constraints,
      synthesisConstraints: request.synthesisConstraints,
      warnings: collection.warnings,
      analyses: collection.analyses
    });
    const synthesisPool = new ProviderSessionPool();
    synthesisPool.set(
      synthesizerProvider,
      createFreshProviderSession(collection.pool.get(synthesizerProvider))
    );
    const synthesis = await runProviderWithRetry({
      provider: synthesizerProvider,
      index: collection.providers.length,
      runId,
      prompt,
      taskPrefix: 'synergize',
      pool: synthesisPool,
      timeoutMs: collection.perProviderTimeoutMs,
      timeoutDefaults: {
        firstTokenMs: collection.perProviderTimeoutMs,
        outputStabilizationMs: collection.perProviderTimeoutMs
      },
      timeouts: request.timeouts,
      maxRetries: maxRetries(request),
      runnerFactory: collection.runnerFactory,
      warnings: collection.warnings
    });

    collection.persistence.updateRunStatusIfNotTerminal(runId, collection.status);

    return {
      run_id: runId,
      status: collection.status,
      report: synthesis.response,
      warnings: Array.from(new Set(collection.warnings)),
      analyses: collection.analyses,
      synthesis
    };
  } catch (err: any) {
    err.run_id = runId;
    err.successfulProviderCount = collection.analyses.length;
    err.failedProviderCount = Math.max(0, collection.providers.length - collection.analyses.length) + 1;
    collection.persistence.updateRunStatusIfNotTerminal(runId, 'FAILED');
    throw err;
  } finally {
    console.log('\n[INFO] Synergize: Keeping active browser sessions open for visual inspection.\n');
  }
}

export async function runCouncilConsultation(request: CouncilConsultationRequest): Promise<CouncilConsultationResult> {
  const runId = `council_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const persistence = request.persistence ?? sqlitePersistence;

  try {
    validateCouncilRequestText(request.question, request.constraints);
    uniqueProviders(request.providers);
    return await runCouncilConsultationInner(request, runId);
  } catch (err: any) {
    if (err?.code === 'INTERVENTION_REQUIRED') {
      err.run_id = runId;
      persistence.updateRunStatusIfNotTerminal(runId, 'INTERVENTION_REQUIRED');
    } else if (isAbortError(err)) {
      err.run_id = runId;
      persistence.updateRunStatusIfNotTerminal(runId, 'CANCELLED');
    } else {
      persistence.updateRunStatusIfNotTerminal(runId, 'FAILED');
    }
    throw err;
  }
}

export async function runSynergizedCouncilConsultation(request: SynergizedCouncilRequest): Promise<SynergizedCouncilResult> {
  const runId = `synergize_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const persistence = request.persistence ?? sqlitePersistence;

  try {
    const combinedConstraints = [request.constraints, request.synthesisConstraints].filter(Boolean).join('\n\n') || undefined;
    validateCouncilRequestText(request.question, combinedConstraints);
    uniqueProviders(request.providers);
    const configuredSynthesizer = request.synthesizerProvider || defaultSynergizerProvider();
    if (configuredSynthesizer) {
      validateProviderList([normalizeProviderId(configuredSynthesizer)], 'synthesizer provider');
    }
    return await runSynergizedCouncilConsultationInner(request, runId);
  } catch (err: any) {
    if (err?.code === 'INTERVENTION_REQUIRED') {
      err.run_id = runId;
      persistence.updateRunStatusIfNotTerminal(runId, 'INTERVENTION_REQUIRED');
    } else if (isAbortError(err)) {
      err.run_id = runId;
      persistence.updateRunStatusIfNotTerminal(runId, 'CANCELLED');
    } else {
      persistence.updateRunStatusIfNotTerminal(runId, 'FAILED');
    }
    throw err;
  }
}
