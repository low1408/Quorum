import crypto from 'crypto';
import { DBService } from '../db/database.ts';
import { config } from '../config/index.ts';
import { OrchestrationRunner } from './runner.ts';
import type { SessionPoolItem } from './runner.ts';
import { calculateRouge } from './rouge.ts';

export type EvaluationStatus =
  | 'preserved'
  | 'partially_preserved'
  | 'omitted'
  | 'distorted'
  | 'contradicted';

export type EvaluatedItem = {
  type?: string;
  text?: string;
  status?: EvaluationStatus | string;
  summary_support?: string;
  reason?: string;
};

export type EvaluatedVerdict = {
  verdict?: string;
  status?: EvaluationStatus | string;
  reason?: string;
};

export type ParsedEvaluation = {
  defender_label?: string;
  items?: EvaluatedItem[];
  verdicts?: EvaluatedVerdict[];
  rationale?: string;
};

export type EvaluationScores = {
  coverageScore: number;
  omissionScore: number;
  distortionScore: number;
  contradictionScore: number;
  verdictAccuracy: number;
  keyClaimsTotal: number;
  keyClaimsPreserved: number;
  keyClaimsOmitted: number;
  keyClaimsDistorted: number;
  keyClaimsContradicted: number;
  rationale: string;
};

export type DefenseForEvaluation = {
  sourceLabel: string;
  taskId: string;
  response: string;
};

const VALID_STATUSES = new Set<EvaluationStatus>([
  'preserved',
  'partially_preserved',
  'omitted',
  'distorted',
  'contradicted'
]);

function normalizeStatus(status: unknown): EvaluationStatus | null {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  return VALID_STATUSES.has(normalized as EvaluationStatus) ? normalized as EvaluationStatus : null;
}

function scoreWeight(status: EvaluationStatus | null): number {
  if (status === 'preserved') return 1;
  if (status === 'partially_preserved') return 0.5;
  return 0;
}

export function buildClaimEvaluationPrompt(params: {
  defenderLabel: string;
  defenderResponse: string;
  finalSynthesis: string;
}): string {
  return `CLAIM_LEVEL_FAITHFULNESS_EVALUATOR\n\n` +
    `You are evaluating whether a combined final synthesis faithfully represents one defender response.\n` +
    `Compare only the supplied defender response and final synthesis. Do not use outside knowledge.\n` +
    `Keep provider identity blind. Use the defender label exactly as supplied.\n` +
    `Extract atomic defender claims, caveats, and explicit HOLD/REFINE/RETRACT/UNCERTAIN verdicts.\n` +
    `Classify each item against the final synthesis using only: preserved, partially_preserved, omitted, distorted, contradicted.\n` +
    `Return JSON only. Do not wrap the JSON in markdown.\n\n` +
    `Required JSON shape:\n` +
    `{"defender_label":"${params.defenderLabel}","items":[{"type":"claim","text":"...","status":"preserved","summary_support":"...","reason":"..."}],"verdicts":[{"verdict":"REFINE","status":"preserved","reason":"..."}],"rationale":"..."}\n\n` +
    `--- DEFENDER RESPONSE (${params.defenderLabel}) ---\n${params.defenderResponse}\n\n` +
    `--- FINAL SYNTHESIS ---\n${params.finalSynthesis}`;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  throw new Error('Evaluator response did not contain a JSON object.');
}

export function parseEvaluatorResponse(responseText: string): ParsedEvaluation {
  const parsed = JSON.parse(extractJsonObject(responseText));
  return {
    defender_label: typeof parsed.defender_label === 'string' ? parsed.defender_label : undefined,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts : [],
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : ''
  };
}

export function scoreParsedEvaluation(parsed: ParsedEvaluation): EvaluationScores {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const statuses = items.map(item => normalizeStatus(item.status));
  const total = statuses.length;

  const preserved = statuses.filter(status => status === 'preserved' || status === 'partially_preserved').length;
  const omitted = statuses.filter(status => status === 'omitted').length;
  const distorted = statuses.filter(status => status === 'distorted').length;
  const contradicted = statuses.filter(status => status === 'contradicted').length;
  const weightedCoverage = statuses.reduce((sum, status) => sum + scoreWeight(status), 0);

  const verdictStatuses = verdicts.map(verdict => normalizeStatus(verdict.status));
  const verdictTotal = verdictStatuses.length;
  const verdictWeighted = verdictStatuses.reduce((sum, status) => sum + scoreWeight(status), 0);

  return {
    coverageScore: total === 0 ? 0 : weightedCoverage / total,
    omissionScore: total === 0 ? 0 : omitted / total,
    distortionScore: total === 0 ? 0 : distorted / total,
    contradictionScore: total === 0 ? 0 : contradicted / total,
    verdictAccuracy: verdictTotal === 0 ? 0 : verdictWeighted / verdictTotal,
    keyClaimsTotal: total,
    keyClaimsPreserved: preserved,
    keyClaimsOmitted: omitted,
    keyClaimsDistorted: distorted,
    keyClaimsContradicted: contradicted,
    rationale: parsed.rationale || ''
  };
}

function zeroScores(rationale: string): EvaluationScores {
  return {
    coverageScore: 0,
    omissionScore: 0,
    distortionScore: 0,
    contradictionScore: 0,
    verdictAccuracy: 0,
    keyClaimsTotal: 0,
    keyClaimsPreserved: 0,
    keyClaimsOmitted: 0,
    keyClaimsDistorted: 0,
    keyClaimsContradicted: 0,
    rationale
  };
}

export function scoreEvaluatorResponse(responseText: string): {
  scores: EvaluationScores;
  responseJson: string | null;
  parsed: ParsedEvaluation | null;
} {
  try {
    const parsed = parseEvaluatorResponse(responseText);
    return {
      parsed,
      scores: scoreParsedEvaluation(parsed),
      responseJson: JSON.stringify(parsed)
    };
  } catch (error: any) {
    return {
      parsed: null,
      scores: zeroScores(`parse failure: ${error?.message || String(error)}`),
      responseJson: responseText ? JSON.stringify({ raw_response_text: responseText }) : null
    };
  }
}

function evaluatorPoolItem(basePoolItem?: SessionPoolItem): SessionPoolItem | undefined {
  if (!basePoolItem) return undefined;
  return {
    browser: basePoolItem.browser,
    context: basePoolItem.context,
    page: null,
    hasActiveThread: false,
    isCdp: basePoolItem.isCdp
  };
}

export async function evaluateDefensesAgainstSynthesis(params: {
  runId: string;
  roundNo: number;
  summaryTaskId: string;
  finalSynthesis: string;
  defenses: DefenseForEvaluation[];
  pagePool: Record<string, SessionPoolItem>;
}): Promise<void> {
  if (!config.enableSummaryEvaluation) {
    return;
  }

  const evaluatorProvider = config.evaluatorProvider;
  const basePoolItem = params.pagePool[evaluatorProvider];

  for (const defense of params.defenses) {
    const evaluatorTaskId = `summary_eval_${evaluatorProvider}_r${params.roundNo}_${defense.sourceLabel.replace(/\s+/g, '_')}_${Date.now()}`;
    const rouge = calculateRouge(defense.response, params.finalSynthesis);
    let responseText = '';
    let responseJson: string | null = null;
    let scores: EvaluationScores;

    try {
      const prompt = buildClaimEvaluationPrompt({
        defenderLabel: defense.sourceLabel,
        defenderResponse: defense.response,
        finalSynthesis: params.finalSynthesis
      });

      const runner = new OrchestrationRunner(
        params.runId,
        evaluatorTaskId,
        evaluatorProvider,
        { manageRunStatus: false }
      );
      responseText = await runner.executeTask(prompt, evaluatorPoolItem(basePoolItem));
      const scored = scoreEvaluatorResponse(responseText);
      responseJson = scored.responseJson;
      scores = scored.scores;
    } catch (error: any) {
      scores = zeroScores(`evaluation failure: ${error?.message || String(error)}`);
      if (responseText) {
        responseJson = JSON.stringify({ raw_response_text: responseText });
      }
    }

    DBService.createSummaryEvaluationMetric({
      metricId: `metric_${crypto.randomUUID()}`,
      runId: params.runId,
      roundNo: params.roundNo,
      summaryTaskId: params.summaryTaskId,
      defenderTaskId: defense.taskId,
      summaryArtifactId: null,
      defenderArtifactId: null,
      defenderLabel: defense.sourceLabel,
      coverageScore: scores.coverageScore,
      omissionScore: scores.omissionScore,
      distortionScore: scores.distortionScore,
      contradictionScore: scores.contradictionScore,
      verdictAccuracy: scores.verdictAccuracy,
      keyClaimsTotal: scores.keyClaimsTotal,
      keyClaimsPreserved: scores.keyClaimsPreserved,
      keyClaimsOmitted: scores.keyClaimsOmitted,
      keyClaimsDistorted: scores.keyClaimsDistorted,
      keyClaimsContradicted: scores.keyClaimsContradicted,
      rouge1F1: rouge.rouge1.f1,
      rouge2F1: rouge.rouge2.f1,
      rougeLF1: rouge.rougeL.f1,
      evaluatorProvider,
      evaluatorTaskId,
      evaluatorResponseJson: responseJson,
      evaluatorRationale: scores.rationale
    });

    try {
      DBService.addLineage(defense.taskId, evaluatorTaskId);
      DBService.addLineage(params.summaryTaskId, evaluatorTaskId);
    } catch (error: any) {
      console.warn(`Summary evaluation lineage failed: ${error.message}`);
    }
  }
}
