import { OrchestrationRunner } from './runner.ts';
import type { SessionPoolItem } from './runner.ts';
import { DBService } from '../db/database.ts';
import { evaluateDefensesAgainstSynthesis } from './summaryEvaluation.ts';

const SYNTHESIS_INSTRUCTION =
  `All materials have been provided. Now produce a structured point-by-point synthesis that maps inter-model agreement and divergence. ` +
  `For each substantive claim, state which models mention it, which models disagree, and what each one contributes. ` +
  `Treat model agreement as attribution only, not as proof of truth. Do not judge or resolve disagreements; compress and attribute faithfully. ` +
  `If a response concedes a point without giving a concrete reason, mark it as an unsupported concession rather than treating it as a settled revision.`;

const PARTIAL_SYNTHESIS_INSTRUCTION =
  `${SYNTHESIS_INSTRUCTION} Preserve source labels exactly and avoid provider names. ` +
  `Do not claim that a source said, implied, or conceded anything unless it is directly supported by that source's summary. ` +
  `Make uncertainty and missing coverage explicit so another critic can compare this partial synthesis with a separate partial synthesis.`;

const MASTER_CONSOLIDATION_INSTRUCTION =
  `All parent syntheses have been provided. Consolidate them into one single non-redundant summary. ` +
  `Merge duplicate claims, preserve source labels exactly, and avoid provider names. ` +
  `Do not erase substantive disagreement or uncertainty; compress repeated agreement while preserving who supports, disputes, or omits each important claim. ` +
  `If parent syntheses conflict, state the conflict plainly instead of resolving it without support.`;

const SOCRATIC_CRITIC_INSTRUCTION =
  `You are a Socratic domain critic. Critique the substance of the synthesized meta-summary using probing questions that improve conceptual precision, causal reasoning, evidence quality, definitions, boundary conditions, mechanisms, and missing domain-specific context.\n` +
  `Do not critique the fact that the inputs came from LLMs. Do not argue that model agreement is fake consensus, shared training-data bias, shared omission, or evidence of AI unreliability unless the source text explicitly makes that the topic. Do not spend critique on wording such as "consensus", "agreement", or "models agree"; treat those labels only as attribution scaffolding.\n` +
  `When a claim seems unsupported, ask what concrete evidence, mechanism, assumptions, or source-grounding would strengthen it. Keep the critique focused on the topic itself.`;

const ROTATING_CRITIC_INSTRUCTION =
  `You are a rotating Socratic domain critic. Your output is candidate pressure, not a verdict. Critique the substance of the synthesized meta-summary using probing questions that improve conceptual precision, causal reasoning, evidence quality, definitions, boundary conditions, mechanisms, and missing domain-specific context.\n` +
  `Do not critique the fact that the inputs came from LLMs. Do not argue that model agreement is fake consensus, shared training-data bias, shared omission, or evidence of AI unreliability unless the source text explicitly makes that the topic. Do not spend critique on wording such as "consensus", "agreement", or "models agree"; treat those labels only as attribution scaffolding.\n` +
  `Every critique item must be a tagged bullet in this exact shape: - <label_one> <label_two?> Claim/target: ... | Problem: ... | Probe: ...\n` +
  `Use only these structural defect labels: <evidence_gap>, <causal_leap>, <definition_gap>, <scope_error>, <missing_mechanism>, <boundary_condition>, <assumption_load>, <counterexample_gap>, <aggregation_artifact>, <priority_mismatch>.\n` +
  `Labels must be orthogonal: choose the smallest set of independent structural failures, not synonyms. Generate distinct critique items and avoid duplicate critiques against the same target. Prefer 4 to 8 high-value critique items unless the synthesis is too short.`;

const DEFENSE_INSTRUCTION =
  `Respond as a rigorous defender of your prior summary, not as a deferential assistant. ` +
  `Do not automatically accept the critique. Separate valid objections from weak or speculative objections.\n` +
  `After responding to the critique, add a section titled "Source Disagreement Check". ` +
  `Answer whether you disagree with any other source summary. If yes, identify the one source you most strongly disagree with first, then list up to two additional specific disagreements if needed. ` +
  `Use this format: "Yes — on ..." or "No — no substantive disagreement found." For each disagreement, name the source label, quote or paraphrase the disputed claim briefly, state your correction, and give the reason from your summary or the supplied source summaries. ` +
  `Do not invent disagreements; if the difference is only emphasis or missing coverage, say so.\n` +
  `For each critique point, use one of these labels: HOLD, REFINE, RETRACT, or UNCERTAIN.\n` +
  `HOLD when your original claim still follows from the provided material or remains the best-supported interpretation. ` +
  `REFINE only when the critique identifies a real ambiguity, missing mechanism, boundary condition, or overstatement. ` +
  `RETRACT only when the critique shows a contradiction, clear factual error, or unsupported claim. ` +
  `UNCERTAIN when the available material is insufficient to decide.\n` +
  `For every REFINE or RETRACT, state the specific reason. For every HOLD, state the support or reasoning. ` +
  `Do not use apologetic language or concede merely because the critique is forcefully phrased. Be concise but rigorous.`;

const ROTATING_DEFENSE_INSTRUCTION =
  `Respond as a rigorous defender of your prior summary, not as a deferential assistant. The rotating critic's tagged defects are candidate objections, not verdicts.\n` +
  `Do not concede because the critic sounds confident. First test whether the critique is wrong. Concede only if your rebuttal fails.\n` +
  `After responding to the tagged critique, add a section titled "Source Disagreement Check". ` +
  `Answer whether you disagree with any other source summary. If yes, identify the one source you most strongly disagree with first, then list up to two additional specific disagreements if needed. ` +
  `Use this format: "Yes — on ..." or "No — no substantive disagreement found." For each disagreement, name the source label, quote or paraphrase the disputed claim briefly, state your correction, and give the reason from your summary or the supplied source summaries. ` +
  `Do not invent disagreements; if the difference is only emphasis or missing coverage, say so.\n` +
  `For every tagged critique item, preserve the critic's tag labels exactly and respond in this format: Tag(s) | Verdict: HOLD/REFINE/RETRACT/UNCERTAIN | Rebuttal test | Reason.\n` +
  `HOLD only when you can show the critique does not defeat the claim, using concrete support or reasoning from your prior summary or the available material. ` +
  `REFINE when the critique is partly right but the claim survives with narrower wording. ` +
  `RETRACT only when the critique exposes an unsupported claim, contradiction, or failed causal/evidence basis. ` +
  `UNCERTAIN when the available material cannot decide whether the critique succeeds.\n` +
  `For every REFINE or RETRACT, name exactly which tagged defect forced the change. Be concise but rigorous.`;

const ROTATING_SYNTHESIS_INSTRUCTION =
  `${SYNTHESIS_INSTRUCTION} Track the rotating critic's defect tags explicitly. ` +
  `For each important tagged defect, classify its status as upheld, defeated, partially resolved, or uncertain based on the defenders' reasons. ` +
  `Do not treat critic objections as true unless defenders fail to answer them with concrete reasons. ` +
  `Do not treat model concessions as true unless the concession gives a concrete reason. Preserve unresolved disagreement instead of smoothing it away.`;

const SOURCE_DISAGREEMENT_SYNTHESIS_INSTRUCTION =
  `Also include a "Source Disagreement Check" section. Summarize which source each defender most strongly disagreed with, the disputed claim, and whether the disagreement is a substantive contradiction, a scope/wording refinement, or only a difference in emphasis. Preserve unresolved disagreements instead of resolving them without support.`;

const SYNTHESIS_PROVIDER_CANDIDATES = ['gemini', 'chatgpt', 'meta'];
const DEFAULT_SOCRATIC_CRITIC_PROVIDERS = ['gemini'];
const SOCRATIC_CRITIQUE_CONSOLIDATOR_PROVIDER = 'chatgpt';

type SummaryRecord = {
  provider: string;
  sourceLabel: string;
  taskId: string;
  summary: string;
};

type ParentSynthesisRecord = {
  provider: string;
  taskId: string;
  title: string;
  sourceLabels: string[];
  synthesis: string;
};

type DefenseRecord = {
  provider: string;
  sourceLabel: string;
  taskId: string;
  parentTaskId: string;
  response: string;
};

type CritiqueRecord = {
  provider: string;
  taskId: string;
  title: string;
  critique: string;
};

type SynthesisRecord = {
  provider: string;
  taskId: string;
  title: string;
  synthesis: string;
};

type GroupedSynthesisRecord = SynthesisRecord & {
  defenses: DefenseRecord[];
};

type MultiSummarizationOptions = {
  criticInstruction?: string;
  criticDisplayName?: string;
  criticProviders?: string[];
  runIdPrefix?: string;
  runTitle?: string;
};

function sourceLabelForIndex(index: number): string {
  let label = '';
  let n = index;

  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return `SOURCE ${label}`;
}

function splitIntoBalancedGroups<T>(items: T[], maxGroups: number): T[][] {
  if (items.length <= 1 || maxGroups <= 1) {
    return [items];
  }

  const groupCount = Math.min(items.length, maxGroups);
  const groups: T[][] = Array.from({ length: groupCount }, () => []);

  items.forEach((item, index) => {
    groups[index % groupCount].push(item);
  });

  return groups.filter(group => group.length > 0);
}

function createFreshProviderPool(source?: SessionPoolItem): SessionPoolItem {
  return {
    browser: source?.browser || null,
    context: source?.context || null,
    page: null,
    hasActiveThread: false,
    isCdp: source?.isCdp
  };
}

function ensurePoolItem(pagePool: Record<string, SessionPoolItem>, provider: string): SessionPoolItem {
  if (!pagePool[provider]) {
    pagePool[provider] = { browser: null, context: null, page: null, hasActiveThread: false };
  }

  return pagePool[provider];
}

function socraticCriticPoolKey(provider: string): string {
  return `socratic_critic:${provider}`;
}

function ensureSocraticCriticPool(pagePool: Record<string, SessionPoolItem>, provider: string): SessionPoolItem {
  const poolKey = socraticCriticPoolKey(provider);
  if (!pagePool[poolKey]) {
    const sourcePool = ensurePoolItem(pagePool, provider);
    pagePool[poolKey] = createFreshProviderPool(sourcePool);
  }

  return pagePool[poolKey];
}

async function closeTransientPoolPage(poolItem: SessionPoolItem, label: string): Promise<void> {
  const page = poolItem.page;
  if (!page) {
    poolItem.hasActiveThread = false;
    return;
  }

  try {
    if (!page.isClosed?.()) {
      await page.close();
      console.log(`🧹 [TAB CLEANUP] Closed transient tab for ${label}.`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [TAB CLEANUP] Failed to close transient tab for ${label}: ${err.message}`);
  } finally {
    poolItem.page = null;
    poolItem.hasActiveThread = false;
  }
}

function selectSynthesisProviders(itemCount: number): string[] {
  return SYNTHESIS_PROVIDER_CANDIDATES.slice(0, Math.max(1, Math.min(itemCount, SYNTHESIS_PROVIDER_CANDIDATES.length)));
}

function buildCriticRotation(pagePool: Record<string, SessionPoolItem>): string[] {
  const preferredCritics = ['gemini', 'chatgpt', 'claude'];
  const existingPreferred = preferredCritics.filter(provider => pagePool[provider]);
  const rotation = existingPreferred.length > 0 ? existingPreferred : preferredCritics;

  return Array.from(new Set(rotation));
}

async function executeRotatingCritique(
  runId: string,
  round: number,
  rotation: string[],
  rotationStartIndex: number,
  pagePool: Record<string, SessionPoolItem>,
  buildPrompt: (criticProvider: string) => string
): Promise<{ critique: string; taskId: string; provider: string; nextRotationIndex: number }> {
  const attempts = rotation.length > 0 ? rotation.length : 1;
  const fallbackRotation = rotation.length > 0 ? rotation : ['gemini'];

  for (let attempt = 0; attempt < attempts; attempt++) {
    const rotationIndex = (rotationStartIndex + attempt) % fallbackRotation.length;
    const criticProvider = fallbackRotation[rotationIndex];
    const sourcePool = ensurePoolItem(pagePool, criticProvider);
    const criticPool = createFreshProviderPool(sourcePool);
    const taskId = `summary_task_${criticProvider}_rotating_critic_r${round}_${Date.now()}`;

    console.log(`\n🤖 [ROTATING CRITIC] Round ${round} using [${criticProvider.toUpperCase()}] as non-authoritative critic...`);

    try {
      const runner = new OrchestrationRunner(runId, taskId, criticProvider);
      const critique = await runner.executeTask(buildPrompt(criticProvider), criticPool, { pasteOnly: true });
      criticPool.hasActiveThread = true;

      if (!sourcePool.browser) {
        pagePool[criticProvider] = criticPool;
      }

      return {
        critique,
        taskId,
        provider: criticProvider,
        nextRotationIndex: (rotationIndex + 1) % fallbackRotation.length
      };
    } catch (err: any) {
      console.error(`❌ Rotating critic failed for provider [${criticProvider.toUpperCase()}]: ${err.message}`);
    } finally {
      await closeTransientPoolPage(criticPool, `rotating critic ${criticProvider.toUpperCase()} round ${round}`);
    }
  }

  throw new Error('All rotating critic providers failed.');
}

function buildSummarySynthesisSegments(summaries: SummaryRecord[], scopeLabel: string): string[] {
  const introSegment = `You are a neutral information synthesizer. I will now send you anonymized summaries of the same source text for ${scopeLabel}. ` +
    `They are labeled ${summaries.map(s => s.sourceLabel).join(', ')}. Do not infer anything from these labels; they are only stable references for attribution. ` +
    `Do not mention or guess provider identities. Please acknowledge each summary as I send it. After I send all summaries, I will ask you to produce a synthesis.\n\n`;

  const segments = [
    introSegment,
    ...summaries.map(s => `=== SUMMARY FROM [${s.sourceLabel}] ===\n${s.summary}`)
  ];

  segments.push(PARTIAL_SYNTHESIS_INSTRUCTION);
  return segments;
}

function buildSourceComparisonText(summaries: SummaryRecord[], currentSourceLabel: string): string {
  return summaries
    .map(s => {
      const marker = s.sourceLabel === currentSourceLabel ? ' (YOUR SOURCE)' : '';
      return `=== SUMMARY FROM [${s.sourceLabel}]${marker} ===\n${s.summary}`;
    })
    .join('\n\n');
}

async function runParentSynthesis(
  runId: string,
  provider: string,
  taskId: string,
  title: string,
  summaries: SummaryRecord[],
  poolItem: SessionPoolItem
): Promise<ParentSynthesisRecord> {
  const sourceLabels = summaries.map(s => s.sourceLabel);
  console.log(`\n🤖 [PARENT SYNTHESIZER] Dispatching ${sourceLabels.join(', ')} to an anonymized ${title} reducer...`);

  try {
    const runner = new OrchestrationRunner(runId, taskId, provider);
    const synthesis = await runner.executeMultiSegmentTask(
      buildSummarySynthesisSegments(summaries, title),
      poolItem
    );
    poolItem.hasActiveThread = true;

    console.log(`✅ [PARENT SYNTHESIZER] ${title} completed for ${sourceLabels.join(', ')}.`);

    return {
      provider,
      taskId,
      title,
      sourceLabels,
      synthesis
    };
  } finally {
    await closeTransientPoolPage(poolItem, `${title} ${provider.toUpperCase()}`);
  }
}

function buildMasterConsolidationSegments(parentSyntheses: ParentSynthesisRecord[]): string[] {
  const introSegment = `You are a master consolidator. I will now send you parent syntheses produced from separate subsets of anonymized source summaries. ` +
    `Each parent synthesis lists the source labels it covered. Do not infer anything from parent titles or source labels; they are only stable attribution references. ` +
    `Do not mention or guess provider identities. Please acknowledge each parent synthesis as I send it. After I send all parent syntheses, I will ask you to produce one consolidated summary.\n\n`;

  const segments = [
    introSegment,
    ...parentSyntheses.map(parent =>
      `=== ${parent.title} (${parent.sourceLabels.join(', ')}) ===\n${parent.synthesis}`
    )
  ];

  segments.push(MASTER_CONSOLIDATION_INSTRUCTION);
  return segments;
}

async function runMasterConsolidation(
  runId: string,
  taskId: string,
  parentSyntheses: ParentSynthesisRecord[],
  pagePool: Record<string, SessionPoolItem>
): Promise<SynthesisRecord> {
  const provider = 'chatgpt';
  const sourcePool = ensurePoolItem(pagePool, provider);
  const poolItem = createFreshProviderPool(sourcePool);

  if (!sourcePool.browser) {
    pagePool[provider] = poolItem;
  }

  console.log(`\n🤖 [MASTER CONSOLIDATOR] Dispatching all parent syntheses to [CHATGPT] for one non-redundant consolidated summary...`);

  try {
    const runner = new OrchestrationRunner(runId, taskId, provider);
    const synthesis = await runner.executeMultiSegmentTask(
      buildMasterConsolidationSegments(parentSyntheses),
      poolItem
    );
    poolItem.hasActiveThread = true;

    console.log(`✅ [MASTER CONSOLIDATOR] ChatGPT completed the consolidated parent summary.`);

    return {
      provider,
      taskId,
      title: 'MASTER CONSOLIDATED SUMMARY',
      synthesis
    };
  } finally {
    await closeTransientPoolPage(poolItem, 'master consolidator CHATGPT');
  }
}

async function runParallelSocraticCritiques(
  runId: string,
  taskIdPrefix: string,
  criticProviders: string[],
  pagePool: Record<string, SessionPoolItem>,
  buildPrompt: (provider: string) => string
): Promise<CritiqueRecord[]> {
  const critiquePromises = criticProviders.map(async (provider, index) => {
    const poolItem = ensureSocraticCriticPool(pagePool, provider);
    const taskId = `${taskIdPrefix}_${provider}_${Date.now()}`;
    const title = `SOCRATIC CRITIQUE ${index + 1}`;

    console.log(`\n🤖 [SOCRATIC CRITIC] Dispatching ${title} to [${provider.toUpperCase()}] in its persistent critic tab...`);
    await new Promise((resolve) => setTimeout(resolve, index * 1000));

    const runner = new OrchestrationRunner(runId, taskId, provider);
    const critique = await runner.executeTask(buildPrompt(provider), poolItem, { pasteOnly: true });
    poolItem.hasActiveThread = true;

    console.log(`✅ [${provider.toUpperCase()}] completed ${title}.`);

    return {
      provider,
      taskId,
      title,
      critique
    };
  });

  const results = await Promise.allSettled(critiquePromises);
  const critiques: CritiqueRecord[] = [];

  for (const res of results) {
    if (res.status === 'fulfilled') {
      critiques.push(res.value);
    } else {
      console.error(`❌ Socratic critic failed: ${res.reason.message}`);
    }
  }

  if (critiques.length === 0) {
    throw new Error('All Socratic critics failed.');
  }

  return critiques;
}

function buildSocraticCritiqueConsolidationSegments(critiques: CritiqueRecord[]): string[] {
  const introSegment = `You are a Socratic critique consolidator. I will now send you critiques from multiple Socratic critics. ` +
    `Do not mention or guess provider identities. Use the critic labels only as stable attribution references. ` +
    `Please acknowledge each critique as I send it. After I send all critiques, consolidate them into one critique.\n\n`;

  const segments = [
    introSegment,
    ...critiques.map((critique, index) =>
      `=== CRITIQUE FROM [CRITIC ${index + 1}] ===\n${critique.critique}`
    )
  ];

  segments.push(
    `All Socratic critiques have been provided. Consolidate them into one non-redundant Socratic critique. ` +
    `Merge similar questions and objections. Preserve distinct high-value questions, tensions, evidence gaps, definition gaps, boundary conditions, mechanisms, and counterexamples. ` +
    `Do not answer the questions. Do not declare a verdict. If critics disagree in emphasis, keep the sharper or more specific version while noting any materially different angle.`
  );

  return segments;
}

async function runSocraticCritiqueConsolidation(
  runId: string,
  taskId: string,
  critiques: CritiqueRecord[],
  pagePool: Record<string, SessionPoolItem>
): Promise<CritiqueRecord> {
  const provider = SOCRATIC_CRITIQUE_CONSOLIDATOR_PROVIDER;
  const sourcePool = ensurePoolItem(pagePool, provider);
  const poolItem = createFreshProviderPool(sourcePool);

  if (!sourcePool.browser) {
    pagePool[provider] = poolItem;
  }

  console.log(`\n🤖 [SOCRATIC CONSOLIDATOR] Dispatching all Socratic critiques to [${provider.toUpperCase()}] for non-redundant consolidation...`);

  try {
    const runner = new OrchestrationRunner(runId, taskId, provider);
    const critique = await runner.executeMultiSegmentTask(
      buildSocraticCritiqueConsolidationSegments(critiques),
      poolItem
    );
    poolItem.hasActiveThread = true;

    console.log(`✅ [SOCRATIC CONSOLIDATOR] ${provider.toUpperCase()} completed the consolidated Socratic critique.`);

    return {
      provider,
      taskId,
      title: 'CONSOLIDATED SOCRATIC CRITIQUE',
      critique
    };
  } finally {
    await closeTransientPoolPage(poolItem, `Socratic consolidator ${provider.toUpperCase()}`);
  }
}

function formatCritiqueRecords(critiques: CritiqueRecord[]): string {
  return critiques
    .map(c => `--- ${c.title} FROM [${c.provider.toUpperCase()}] ---\n${c.critique}`)
    .join('\n\n');
}

async function runParallelSyntheses(
  runId: string,
  taskIdPrefix: string,
  titlePrefix: string,
  providers: string[],
  segments: string[],
  pagePool: Record<string, SessionPoolItem>
): Promise<SynthesisRecord[]> {
  const synthesisPromises = providers.map(async (provider, index) => {
    const sourcePool = ensurePoolItem(pagePool, provider);
    const poolItem = createFreshProviderPool(sourcePool);
    const taskId = `${taskIdPrefix}_${provider}_${Date.now()}`;
    const title = `${titlePrefix} ${index + 1}`;

    if (!sourcePool.browser) {
      pagePool[provider] = poolItem;
    }

    console.log(`\n🤖 [SYNTHESIZER] Dispatching ${title} to [${provider.toUpperCase()}] in a fresh tab...`);
    await new Promise((resolve) => setTimeout(resolve, index * 1000));

    try {
      const runner = new OrchestrationRunner(runId, taskId, provider);
      const synthesis = await runner.executeMultiSegmentTask(segments, poolItem);
      poolItem.hasActiveThread = true;

      console.log(`✅ [${provider.toUpperCase()}] completed ${title}.`);

      return {
        provider,
        taskId,
        title,
        synthesis
      };
    } finally {
      await closeTransientPoolPage(poolItem, `${title} ${provider.toUpperCase()}`);
    }
  });

  const results = await Promise.allSettled(synthesisPromises);
  const syntheses: SynthesisRecord[] = [];

  for (const res of results) {
    if (res.status === 'fulfilled') {
      syntheses.push(res.value);
    } else {
      console.error(`❌ Parallel synthesis failed: ${res.reason.message}`);
    }
  }

  if (syntheses.length === 0) {
    throw new Error('All final synthesizers failed.');
  }

  return syntheses;
}

async function runGroupedDefenseSyntheses(
  runId: string,
  taskIdPrefix: string,
  titlePrefix: string,
  providers: string[],
  defenseGroups: DefenseRecord[][],
  buildSegments: (defenseGroup: DefenseRecord[]) => string[],
  pagePool: Record<string, SessionPoolItem>
): Promise<GroupedSynthesisRecord[]> {
  const synthesisPromises = defenseGroups.map(async (defenseGroup, index) => {
    const provider = providers[index];
    const sourcePool = ensurePoolItem(pagePool, provider);
    const poolItem = createFreshProviderPool(sourcePool);
    const taskId = `${taskIdPrefix}_${provider}_${Date.now()}`;
    const title = `${titlePrefix} ${index + 1}`;
    const sourceLabels = defenseGroup.map(d => d.sourceLabel).join(', ');

    if (!sourcePool.browser) {
      pagePool[provider] = poolItem;
    }

    console.log(`\n🤖 [SYNTHESIZER] Dispatching ${title} to [${provider.toUpperCase()}] with assigned defenses only: ${sourceLabels}...`);
    await new Promise((resolve) => setTimeout(resolve, index * 1000));

    try {
      const runner = new OrchestrationRunner(runId, taskId, provider);
      const synthesis = await runner.executeMultiSegmentTask(buildSegments(defenseGroup), poolItem);
      poolItem.hasActiveThread = true;

      console.log(`✅ [${provider.toUpperCase()}] completed ${title} for ${sourceLabels}.`);

      return {
        provider,
        taskId,
        title,
        synthesis,
        defenses: defenseGroup
      };
    } finally {
      await closeTransientPoolPage(poolItem, `${title} ${provider.toUpperCase()}`);
    }
  });

  const results = await Promise.allSettled(synthesisPromises);
  const syntheses: GroupedSynthesisRecord[] = [];

  for (const res of results) {
    if (res.status === 'fulfilled') {
      syntheses.push(res.value);
    } else {
      console.error(`❌ Grouped defense synthesis failed: ${res.reason.message}`);
    }
  }

  if (syntheses.length === 0) {
    throw new Error('All grouped defense synthesizers failed.');
  }

  return syntheses;
}

function formatSynthesisRecords(syntheses: SynthesisRecord[]): string {
  return syntheses
    .map(s => `--- ${s.title} FROM [${s.provider.toUpperCase()}] ---\n${s.synthesis}`)
    .join('\n\n');
}

/**
 * Multi-LLM Summarization & Meta-Synthesis Engine.
 * Dispatches a source text to a group of selected LLM providers,
 * gathers their individual summaries, splits them across parallel parent
 * synthesizers, consolidates parent syntheses through a ChatGPT master
 * consolidator, and sends the consolidated summary to the Socratic critic.
 * Links all pipeline steps in the SQLite lineage DAG.
 */
export async function runMultiSummarization(
  textToSummarize: string,
  providers: string[] = ['chatgpt', 'claude', 'qwen', 'deepseek', 'meta'],
  pagePool: Record<string, SessionPoolItem> = {},
  options: MultiSummarizationOptions = {}
): Promise<void> {
  const criticInstruction = options.criticInstruction || SOCRATIC_CRITIC_INSTRUCTION;
  const criticDisplayName = options.criticDisplayName || 'Socratic Gemini';
  const criticProviders = options.criticProviders?.length
    ? Array.from(new Set(options.criticProviders))
    : DEFAULT_SOCRATIC_CRITIC_PROVIDERS;
  const runIdPrefix = options.runIdPrefix || 'summary_run';
  const runTitle = options.runTitle || '📝 MULTI-LLM COMBINED SUMMARIZATION INITIATED 📝';

  console.log('\n============================================================');
  console.log(`       ${runTitle}`);
  console.log(`Text Length: ${textToSummarize.length} characters`);
  console.log(`Initial Summarizers: ${providers.map(p => p.toUpperCase()).join(', ')}`);
  console.log(`Parent Synthesizers: GEMINI + CHATGPT + META, scaled to available source summaries`);
  console.log(`Master Consolidator: CHATGPT`);
  console.log(`Socratic Critics: ${criticProviders.map(p => p.toUpperCase()).join(', ')}`);
  console.log(`Socratic Critique Consolidator: ${SOCRATIC_CRITIQUE_CONSOLIDATOR_PROVIDER.toUpperCase()}`);
  console.log('============================================================\n');

  const runId = `${runIdPrefix}_${Date.now()}`;
  const summaries: SummaryRecord[] = [];

  try {
    // Step 1: Run summarization across all selected initial LLMs in parallel
    const summaryPromises = providers.map(async (provider, index) => {
      const taskId = `summary_task_${provider}_${Date.now()}`;
      console.log(`\n🤖 [SUMMARIZER] Launching and dispatching to [${provider.toUpperCase()}]...`);

      if (!pagePool[provider]) {
        pagePool[provider] = { browser: null, context: null, page: null, hasActiveThread: false };
      }
      const poolItem = pagePool[provider];

      // Formulate custom prompt for initial LLM summary
      const prompt = `${textToSummarize}`;

      // Stagger context launch slightly (1s apart) to prevent potential OS-level resource contentions or CPU spikes
      await new Promise((resolve) => setTimeout(resolve, index * 1000));

      const runner = new OrchestrationRunner(runId, taskId, provider);
      const summary = await runner.executeTask(prompt, poolItem);
      console.log(`✅ [${provider.toUpperCase()}] completed its summary successfully.`);

      poolItem.hasActiveThread = true;
      return {
        provider,
        sourceLabel: sourceLabelForIndex(index),
        taskId,
        summary
      };
    });

    const results = await Promise.allSettled(summaryPromises);

    for (const res of results) {
      if (res.status === 'fulfilled') {
        summaries.push(res.value);
      } else {
        console.error(`❌ Initial summarizer failed: ${res.reason.message}`);
      }
    }

    if (summaries.length === 0) {
      throw new Error('All initial summarization providers failed.');
    }

    // Step 2: Split anonymized summaries across parent synthesizers in parallel.
    console.log(`\n🤖 [PARENT SYNTHESIZERS] Splitting anonymized summaries across parallel reducers...`);
    const geminiProvider = 'gemini';

    if (!pagePool[geminiProvider]) {
      pagePool[geminiProvider] = { browser: null, context: null, page: null, hasActiveThread: false };
    }

    const parentSynthesizerProviders = selectSynthesisProviders(summaries.length);
    const summaryGroups = splitIntoBalancedGroups(summaries, parentSynthesizerProviders.length);
    const parentSynthesisPromises = summaryGroups.map((group, index) => {
      const provider = parentSynthesizerProviders[index];
      const taskId = `summary_task_${provider}_parent_synthesis_${index + 1}_${Date.now()}`;
      const title = `PARENT SYNTHESIS ${index + 1}`;
      const sourcePool = pagePool[provider];
      const providerPool = createFreshProviderPool(sourcePool);

      if (!sourcePool?.browser) {
        pagePool[provider] = providerPool;
      }

      return runParentSynthesis(runId, provider, taskId, title, group, providerPool);
    });

    const parentSynthesisResults = await Promise.allSettled(parentSynthesisPromises);
    const parentSyntheses: ParentSynthesisRecord[] = [];

    for (const res of parentSynthesisResults) {
      if (res.status === 'fulfilled') {
        parentSyntheses.push(res.value);
      } else {
        console.error(`❌ Parent synthesis failed: ${res.reason.message}`);
      }
    }

    if (parentSyntheses.length === 0) {
      throw new Error('All parent synthesizers failed.');
    }

    const parentSynthesesText = parentSyntheses
      .map(parent => `--- ${parent.title} (${parent.sourceLabels.join(', ')}) ---\n${parent.synthesis}`)
      .join('\n\n');

    // Step 3: Master consolidation in ChatGPT.
    const masterConsolidationTaskId = `summary_task_chatgpt_master_consolidation_${Date.now()}`;
    const masterConsolidation = await runMasterConsolidation(
      runId,
      masterConsolidationTaskId,
      parentSyntheses,
      pagePool
    );
    const masterConsolidationText = `--- ${masterConsolidation.title} FROM [CHATGPT] ---\n${masterConsolidation.synthesis}`;
    // Step 4: Parallel Socratic Meta-Critique + consolidated critique.
    console.log(`\n🤖 [SOCRATIC] Piping master consolidated summary to parallel Socratic critics: ${criticProviders.map(p => p.toUpperCase()).join(', ')}...`);
    const buildSocraticPrompt = () => `${criticInstruction}\n\n` +
      `Below is a master consolidated summary built from parent syntheses of anonymized source summaries. ` +
      `The parent syntheses each saw only their listed source labels before the master consolidator merged them. ` +
      `Treat source labels only as attribution scaffolding, and do not discuss provider identity. ` +
      `Critique the combined topic-level substance, including any remaining tensions or possible over-compression where relevant. ` +
      `When describing a potential misrepresentation, specify the exact source label or master-summary wording that needs checking rather than accusing an unnamed model.\n\n` +
      `${masterConsolidationText}`;

    const socraticCritiques = await runParallelSocraticCritiques(
      runId,
      'summary_task_socratic',
      criticProviders,
      pagePool,
      buildSocraticPrompt
    );
    const socraticCritiquesText = formatCritiqueRecords(socraticCritiques);
    const consolidatedSocraticTaskId = `summary_task_chatgpt_socratic_consolidation_${Date.now()}`;
    const consolidatedSocraticCritique = await runSocraticCritiqueConsolidation(
      runId,
      consolidatedSocraticTaskId,
      socraticCritiques,
      pagePool
    );
    const socraticCritique = consolidatedSocraticCritique.critique;

    // Step 5: Socratic Defense Step - Pipe questions back to the initial Answer models
    console.log(`\n🤖 [SOCRATIC RESPONSE] Piping Socratic critique back to the Answer models to defend/refine...`);
    const defensePromises = summaries.map(async (s, index) => {
      const provider = s.provider;
      const poolItem = pagePool[provider];

      const defenseTaskId = `summary_task_${provider}_defense_${Date.now()}`;
      console.log(`\n🤖 [DEFENDER] Dispatching Socratic critique back to [${provider.toUpperCase()}] in its active tab...`);

      // Build the disagreement-check context from OTHER sources only.
      // The defender already produced their own summary earlier in this thread,
      // so re-sending it is redundant and inflates the prompt unnecessarily.
      // Trimming self from the comparison set saves ~20-40% per defender.
      const otherSummaries = summaries.filter(other => other.sourceLabel !== s.sourceLabel);
      const otherSummariesText = otherSummaries.length > 0
        ? otherSummaries
            .map(other => `=== SUMMARY FROM [${other.sourceLabel}] ===\n${other.summary}`)
            .join('\n\n')
        : '(No other source summaries available.)';

      // Send only a reference note for the master consolidated summary rather
      // than pasting the full text again — the Socratic critique already quotes
      // from it, so defenders have sufficient context. This reduces prompt size
      // for constrained providers (Qwen, MiMo) while preserving full context.
      const masterConsolidationRef =
        `[The master consolidated summary referenced by the Socratic critic has been ` +
        `built from the parent syntheses of all anonymized source summaries. ` +
        `The critique below quotes from it directly where relevant.]`;

      const defensePrompt = `Evaluate the critique against the substance of the claims. ` +
        `Respond to all the probing questions or points raised by the Socratic critic, particularly those relevant to your claims, or refine/defend your position.\n\n` +
        `--- MASTER CONSOLIDATED SUMMARY (reference) ---\n` +
        `${masterConsolidationRef}\n\n` +
        `--- OTHER ANONYMIZED SOURCE SUMMARIES FOR DISAGREEMENT CHECK ---\n` +
        `${otherSummariesText}\n\n` +
        `--- SOCRATIC CRITIQUE ---\n` +
        `${socraticCritique}\n\n` +
        `${DEFENSE_INSTRUCTION}`;

      // Stagger slightly (1s apart) to prevent potential OS-level resource contentions or CPU spikes
      await new Promise((resolve) => setTimeout(resolve, index * 1000));

      const runner = new OrchestrationRunner(runId, defenseTaskId, provider);
      const defenseResponse = await runner.executeTask(defensePrompt, poolItem);
      console.log(`✅ [${provider.toUpperCase()}] completed its Socratic defense/refinement.`);

      return {
        provider,
        sourceLabel: s.sourceLabel,
        taskId: defenseTaskId,
        parentTaskId: s.taskId,
        response: defenseResponse
      };
    });

    const defenseResults = await Promise.allSettled(defensePromises);
    const defenses: { provider: string; sourceLabel: string; taskId: string; parentTaskId: string; response: string }[] = [];

    for (const res of defenseResults) {
      if (res.status === 'fulfilled') {
        defenses.push(res.value);
      } else {
        console.error(`❌ Socratic defense failed for provider: ${res.reason.message}`);
      }
    }

    if (defenses.length === 0) {
      throw new Error('All Answer models failed to respond to the Socratic critique.');
    }

    // Step 6: Final Socratically-Refined Meta-Synthesis (Consolidate the defenses)
    const finalSynthesisProviders = selectSynthesisProviders(defenses.length);
    const defenseGroups = splitIntoBalancedGroups(defenses, finalSynthesisProviders.length);
    const assignedFinalSynthesisProviders = finalSynthesisProviders.slice(0, defenseGroups.length);
    console.log(`\n🤖 [AGGREGATORS] Splitting Socratic defenses across refined synthesizers: ${assignedFinalSynthesisProviders.map(p => p.toUpperCase()).join(', ')}...`);

    const combinedDefensesText = defenses
      .map(d => `=== RESPONSE FROM [${d.sourceLabel}] ===\n${d.response}`)
      .join('\n\n');

    const buildRefinedSegments = (defenseGroup: DefenseRecord[]): string[] => {
      const refinedSegments: string[] = [];
      const refinedSysPrefix = `You are a neutral information synthesizer. I will now send you the master consolidated summary that was critiqued, the Socratic critique, and only your assigned responses/defenses from anonymized sources (${defenseGroup.map(d => d.sourceLabel).join(', ')}). ` +
      `Other defenses are assigned to separate synthesizers; do not infer their content. ` +
      `Use the source labels only as stable attribution references. Do not discuss model identity or provider attribution. Please acknowledge each piece as I send it.\n\n`;

      refinedSegments.push(refinedSysPrefix + `--- MASTER CONSOLIDATED SUMMARY THAT WAS CRITIQUED ---\n${masterConsolidationText}`);
      refinedSegments.push(`--- SOCRATIC CRITIQUE ---\n${socraticCritique}`);

      for (const d of defenseGroup) {
        refinedSegments.push(`=== RESPONSE/DEFENSE FROM [${d.sourceLabel}] ===\n${d.response}`);
      }

      refinedSegments.push(`${SYNTHESIS_INSTRUCTION}\n\n${SOURCE_DISAGREEMENT_SYNTHESIS_INSTRUCTION}`);
      return refinedSegments;
    };

    const finalSyntheses = await runGroupedDefenseSyntheses(
      runId,
      'summary_task_refined_synthesis',
      'REFINED SYNTHESIS',
      assignedFinalSynthesisProviders,
      defenseGroups,
      buildRefinedSegments,
      pagePool
    );
    const finalRefinedSynthesis = formatSynthesisRecords(finalSyntheses);

    for (const synthesis of finalSyntheses) {
      await evaluateDefensesAgainstSynthesis({
        runId,
        roundNo: 1,
        summaryTaskId: synthesis.taskId,
        finalSynthesis: synthesis.synthesis,
        defenses: synthesis.defenses,
        pagePool
      });
    }

    // Link lineage: initial summaries -> parent syntheses -> master consolidation -> Socratic critics -> critique consolidation -> defenses -> refined synthesis.
    console.log(`\n🔗 Linking lineage DAG edges (Initial Summaries -> Parent Syntheses -> Master Consolidation -> Socratic Critics -> Socratic Consolidation -> Defenses -> Refined Synthesis):`);

    // Initial Summaries -> Parent Syntheses
    for (const parent of parentSyntheses) {
      for (const s of summaries.filter(summary => parent.sourceLabels.includes(summary.sourceLabel))) {
        console.log(`   🔗 Parent [${s.taskId}] -> Child [${parent.taskId}]`);
        DBService.addLineage(s.taskId, parent.taskId);
      }
    }
    // Parent Syntheses -> Master Consolidation
    for (const parent of parentSyntheses) {
      console.log(`   🔗 Parent [${parent.taskId}] -> Child [${masterConsolidation.taskId}]`);
      DBService.addLineage(parent.taskId, masterConsolidation.taskId);
    }

    // Master Consolidation -> Socratic Critics
    for (const critique of socraticCritiques) {
      console.log(`   🔗 Parent [${masterConsolidation.taskId}] -> Child [${critique.taskId}]`);
      DBService.addLineage(masterConsolidation.taskId, critique.taskId);
    }

    // Socratic Critics -> Socratic Consolidation
    for (const critique of socraticCritiques) {
      console.log(`   🔗 Parent [${critique.taskId}] -> Child [${consolidatedSocraticCritique.taskId}]`);
      DBService.addLineage(critique.taskId, consolidatedSocraticCritique.taskId);
    }

    // Consolidated Socratic Critique & Initial Summaries -> Defenses
    for (const d of defenses) {
      console.log(`   🔗 Parent [${consolidatedSocraticCritique.taskId}] -> Child [${d.taskId}]`);
      DBService.addLineage(consolidatedSocraticCritique.taskId, d.taskId);
      console.log(`   🔗 Parent [${d.parentTaskId}] -> Child [${d.taskId}]`);
      DBService.addLineage(d.parentTaskId, d.taskId);
    }

    // Defenses -> Refined Syntheses
    for (const synthesis of finalSyntheses) {
      for (const d of synthesis.defenses) {
        console.log(`   🔗 Parent [${d.taskId}] -> Child [${synthesis.taskId}]`);
        DBService.addLineage(d.taskId, synthesis.taskId);
      }
    }

    console.log('\n============================================================');
    console.log('       🎉 ROUND 1 SOCRATIC DIALOGUE COMPLETE 🎉');
    console.log('============================================================');
    console.log('\n✨ PARENT SYNTHESES (Anonymized Parallel Reducers):');
    console.log('------------------------------------------------------------');
    console.log(parentSynthesesText);
    console.log('------------------------------------------------------------\n');
    console.log('\n✨ MASTER CONSOLIDATED SUMMARY (ChatGPT):');
    console.log('------------------------------------------------------------');
    console.log(masterConsolidationText);
    console.log('------------------------------------------------------------\n');
    console.log(`\n✨ INDIVIDUAL SOCRATIC CRITIQUES (${criticDisplayName} Set):`);
    console.log('------------------------------------------------------------');
    console.log(socraticCritiquesText);
    console.log('------------------------------------------------------------\n');
    console.log(`\n✨ CONSOLIDATED SOCRATIC CRITIQUE & DEEPER PROBING QUESTIONS:`);
    console.log('------------------------------------------------------------');
    console.log(socraticCritique);
    console.log('------------------------------------------------------------\n');
    console.log('\n✨ RESPONSES & DEFENSES FROM ANSWER MODELS:');
    console.log('------------------------------------------------------------');
    console.log(combinedDefensesText);
    console.log('------------------------------------------------------------\n');
    console.log('\n✨ SOCRATICALLY-REFINED FINAL META-SYNTHESES (From Parallel Refined Aggregators):');
    console.log('------------------------------------------------------------');
    console.log(finalRefinedSynthesis);
    console.log('------------------------------------------------------------\n');
    console.log(`Parent Synthesis Task IDs: ${parentSyntheses.map(parent => parent.taskId).join(', ')}`);
    console.log(`Master Consolidation Task ID: ${masterConsolidation.taskId}`);
    console.log(`Socratic Critic Task IDs: ${socraticCritiques.map(c => c.taskId).join(', ')}`);
    console.log(`Socratic Critique Consolidation Task ID: ${consolidatedSocraticCritique.taskId}`);
    console.log(`Refined Synthesis Task IDs: ${finalSyntheses.map(s => s.taskId).join(', ')}`);
    console.log('============================================================');
    console.log('To trace the logical aggregation lineage inside the database,');
    console.log('copy any Refined Synthesis Task ID and paste it into Menu Option 4 (Recursive Provenance).');
    console.log('============================================================\n');

    // Continuous Socratic Dialogue Loop until CTRL-C is pressed
    let currentSocraticCritique = socraticCritique;
    let currentRefinedSynthesis = finalRefinedSynthesis;
    let round = 1;

    while (true) {
      round++;
      console.log(`\n============================================================`);
      console.log(`       🔄 STARTING SOCRATIC DIALOGUE ROUND ${round} 🔄`);
      console.log(`============================================================\n`);

      // 1. Pipe the latest refined synthesis back to the Socratic critics to ask next-level questions
      console.log(`\n🤖 [SOCRATIC] Piping latest refined synthesis to parallel Socratic critics for next-level critique: ${criticProviders.map(p => p.toUpperCase()).join(', ')}...`);
      const buildRoundSocraticPrompt = () => `${criticInstruction}\n\n` +
        `Below is the latest refined synthesis after the previous round of critique:\\n\\n` +
        `${currentRefinedSynthesis}\\n\\n` +
        `Please provide a follow-up critique. Ask deeper, next-level probing questions, challenge any remaining topic-level gaps, or raise new counter-arguments to push for higher conceptual precision and clarity:`;

      const roundSocraticCritiques = await runParallelSocraticCritiques(
        runId,
        `summary_task_socratic_r${round}`,
        criticProviders,
        pagePool,
        buildRoundSocraticPrompt
      );
      const roundSocraticCritiquesText = formatCritiqueRecords(roundSocraticCritiques);
      const roundConsolidatedSocraticCritique = await runSocraticCritiqueConsolidation(
        runId,
        `summary_task_chatgpt_socratic_consolidation_r${round}_${Date.now()}`,
        roundSocraticCritiques,
        pagePool
      );
      currentSocraticCritique = roundConsolidatedSocraticCritique.critique;

      console.log(`\n✨ INDIVIDUAL SOCRATIC CRITIQUES ROUND ${round}:`);
      console.log('------------------------------------------------------------');
      console.log(roundSocraticCritiquesText);
      console.log('------------------------------------------------------------\n');
      console.log(`\n✨ CONSOLIDATED SOCRATIC CRITIQUE ROUND ${round}:`);
      console.log('------------------------------------------------------------');
      console.log(currentSocraticCritique);
      console.log('------------------------------------------------------------\n');

      // 2. Pipe this next-level critique back to the initial Answer models
      console.log(`\n🤖 [SOCRATIC RESPONSE] Piping new critique to the Answer models to defend/refine...`);
      const roundDefensePromises = defenses.map(async (d, index) => {
        const provider = d.provider;
        const poolItem = pagePool[provider];
        const roundDefenseTaskId = `summary_task_${provider}_defense_r${round}_${Date.now()}`;

        console.log(`\n🤖 [DEFENDER] Dispatching new critique back to [${provider.toUpperCase()}] in its active tab...`);

        const roundDefensePrompt = `Evaluate the critique against the substance of the claims. ` +
          `Respond to all the probing questions or points raised by the Socratic critic, particularly those relevant to your claims, or refine/defend your position.\n\n` +
          `--- SOCRATIC CRITIQUE ---\n${currentSocraticCritique}\n\n` +
          `${DEFENSE_INSTRUCTION}`;

        await new Promise((resolve) => setTimeout(resolve, index * 1000));

        const runner = new OrchestrationRunner(runId, roundDefenseTaskId, provider);
        const defenseResponse = await runner.executeTask(roundDefensePrompt, poolItem);
        console.log(`✅ [${provider.toUpperCase()}] completed defense/refinement for round ${round}.`);

        return {
          provider,
          sourceLabel: d.sourceLabel,
          taskId: roundDefenseTaskId,
          parentTaskId: d.taskId,
          response: defenseResponse
        };
      });

      const roundDefenseResults = await Promise.allSettled(roundDefensePromises);
      const newDefenses: typeof defenses = [];

      for (const res of roundDefenseResults) {
        if (res.status === 'fulfilled') {
          newDefenses.push(res.value);
        } else {
          console.error(`❌ Socratic defense failed in round ${round}: ${res.reason.message}`);
        }
      }

      if (newDefenses.length === 0) {
        console.error('All Answer models failed to respond in this round. Ending loop.');
        break;
      }

      // Link lineage for this round's critiques and defenses:
      for (const critique of roundSocraticCritiques) {
        DBService.addLineage(critique.taskId, roundConsolidatedSocraticCritique.taskId);
      }
      for (const nd of newDefenses) {
        DBService.addLineage(roundConsolidatedSocraticCritique.taskId, nd.taskId);
        DBService.addLineage(nd.parentTaskId, nd.taskId);
      }

      // Update defenses array so the next round maps to these task IDs as parents
      defenses.length = 0;
      defenses.push(...newDefenses);

      // 3. Perform updated refined meta-synthesis
      const roundSynthesisProviders = selectSynthesisProviders(newDefenses.length);
      const roundDefenseGroups = splitIntoBalancedGroups(newDefenses, roundSynthesisProviders.length);
      const assignedRoundSynthesisProviders = roundSynthesisProviders.slice(0, roundDefenseGroups.length);
      console.log(`\n🤖 [AGGREGATORS] Splitting defenses into round ${round} refined meta-syntheses with ${assignedRoundSynthesisProviders.map(p => p.toUpperCase()).join(', ')}...`);

      const buildRoundSegments = (defenseGroup: DefenseRecord[]): string[] => {
        const roundSegments: string[] = [];

        const roundSysPrefix = `You are a neutral information synthesizer. I will now send you only your assigned responses/defenses from anonymized sources (${defenseGroup.map(d => d.sourceLabel).join(', ')}) to a Socratic critique. ` +
        `Other defenses are assigned to separate synthesizers; do not infer their content. ` +
        `Use the source labels only as stable attribution references. Do not discuss model identity or provider attribution. Please acknowledge each piece as I send it.\n\n`;

        for (let i = 0; i < defenseGroup.length; i++) {
          const d = defenseGroup[i];
          const content = `=== RESPONSE FROM [${d.sourceLabel}] ===\n${d.response}`;
          roundSegments.push(i === 0 ? roundSysPrefix + content : content);
        }

        roundSegments.push(`${SYNTHESIS_INSTRUCTION}\n\n${SOURCE_DISAGREEMENT_SYNTHESIS_INSTRUCTION}`);
        return roundSegments;
      };

      const roundFinalSyntheses = await runGroupedDefenseSyntheses(
        runId,
        `summary_task_refined_synthesis_r${round}`,
        `REFINED SYNTHESIS ROUND ${round}`,
        assignedRoundSynthesisProviders,
        roundDefenseGroups,
        buildRoundSegments,
        pagePool
      );
      currentRefinedSynthesis = formatSynthesisRecords(roundFinalSyntheses);

      for (const synthesis of roundFinalSyntheses) {
        await evaluateDefensesAgainstSynthesis({
          runId,
          roundNo: round,
          summaryTaskId: synthesis.taskId,
          finalSynthesis: synthesis.synthesis,
          defenses: synthesis.defenses,
          pagePool
        });
      }

      // Link lineage
      for (const synthesis of roundFinalSyntheses) {
        for (const nd of synthesis.defenses) {
          DBService.addLineage(nd.taskId, synthesis.taskId);
        }
      }

      console.log('\n============================================================');
      console.log(`       🎉 ROUND ${round} SOCRATIC DIALOGUE COMPLETE 🎉`);
      console.log('============================================================');
      console.log(`\n✨ SOCRATICALLY-REFINED META-SYNTHESES ROUND ${round} (From Parallel Refined Aggregators):`);
      console.log('------------------------------------------------------------');
      console.log(currentRefinedSynthesis);
      console.log('------------------------------------------------------------\n');
      console.log(`Socratic Critic Round ${round} Task IDs: ${roundSocraticCritiques.map(c => c.taskId).join(', ')}`);
      console.log(`Socratic Critique Consolidation Round ${round} Task ID: ${roundConsolidatedSocraticCritique.taskId}`);
      console.log(`Refined Synthesis Round ${round} Task IDs: ${roundFinalSyntheses.map(s => s.taskId).join(', ')}`);
      console.log('Press CTRL-C at any time to terminate the Socratic dialogue loop.');
      console.log('============================================================\n');

      // Add a small cool-down delay (3s) before launching the next round
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

  } catch (err: any) {
    console.error(`❌ Summarization workflow failed: ${err.message}`);
    throw err;
  } finally {
    console.log('\n[INFO] Keeping active browser sessions open for visual inspection.\n');
  }
}

/**
 * Variant summarization flow that preserves the existing parent synthesis and
 * defense loop, but uses rotating non-authoritative critics with tagged defects.
 */
export async function runRotatingCriticSummarization(
  textToSummarize: string,
  providers: string[] = ['chatgpt', 'claude', 'qwen', 'deepseek', 'meta'],
  pagePool: Record<string, SessionPoolItem> = {}
): Promise<void> {
  console.log('\n============================================================');
  console.log('       🧭 ROTATING CRITIC SUMMARIZATION INITIATED 🧭');
  console.log(`Text Length: ${textToSummarize.length} characters`);
  console.log(`Initial Summarizers: ${providers.map(p => p.toUpperCase()).join(', ')}`);
  console.log('Parent Synthesizers: GEMINI + CHATGPT + META, scaled to available source summaries');
  console.log('Critics rotate across GEMINI + CHATGPT + CLAUDE when available');
  console.log('============================================================\n');

  const runId = `rotating_critic_run_${Date.now()}`;
  const summaries: SummaryRecord[] = [];

  try {
    const summaryPromises = providers.map(async (provider, index) => {
      const taskId = `summary_task_${provider}_${Date.now()}`;
      console.log(`\n🤖 [SUMMARIZER] Launching and dispatching to [${provider.toUpperCase()}]...`);

      const poolItem = ensurePoolItem(pagePool, provider);
      const prompt = `Please be as concise as possible:\n\n${textToSummarize}`;

      await new Promise((resolve) => setTimeout(resolve, index * 1000));

      const runner = new OrchestrationRunner(runId, taskId, provider);
      const summary = await runner.executeTask(prompt, poolItem);
      console.log(`✅ [${provider.toUpperCase()}] completed its summary successfully.`);

      poolItem.hasActiveThread = true;
      return {
        provider,
        sourceLabel: sourceLabelForIndex(index),
        taskId,
        summary
      };
    });

    const results = await Promise.allSettled(summaryPromises);

    for (const res of results) {
      if (res.status === 'fulfilled') {
        summaries.push(res.value);
      } else {
        console.error(`❌ Initial summarizer failed: ${res.reason.message}`);
      }
    }

    if (summaries.length === 0) {
      throw new Error('All initial summarization providers failed.');
    }

    console.log(`\n🤖 [PARENT SYNTHESIZERS] Splitting anonymized summaries across parallel reducers...`);
    const geminiProvider = 'gemini';
    ensurePoolItem(pagePool, geminiProvider);

    const parentSynthesizerProviders = selectSynthesisProviders(summaries.length);
    const summaryGroups = splitIntoBalancedGroups(summaries, parentSynthesizerProviders.length);
    const parentSynthesisPromises = summaryGroups.map((group, index) => {
      const provider = parentSynthesizerProviders[index];
      const taskId = `summary_task_${provider}_parent_synthesis_${index + 1}_${Date.now()}`;
      const title = `PARENT SYNTHESIS ${index + 1}`;
      const sourcePool = ensurePoolItem(pagePool, provider);
      const providerPool = createFreshProviderPool(sourcePool);

      if (!sourcePool.browser) {
        pagePool[provider] = providerPool;
      }

      return runParentSynthesis(runId, provider, taskId, title, group, providerPool);
    });

    const parentSynthesisResults = await Promise.allSettled(parentSynthesisPromises);
    const parentSyntheses: ParentSynthesisRecord[] = [];

    for (const res of parentSynthesisResults) {
      if (res.status === 'fulfilled') {
        parentSyntheses.push(res.value);
      } else {
        console.error(`❌ Parent synthesis failed: ${res.reason.message}`);
      }
    }

    if (parentSyntheses.length === 0) {
      throw new Error('All parent synthesizers failed.');
    }

    const parentSynthesesText = parentSyntheses
      .map(parent => `--- ${parent.title} (${parent.sourceLabels.join(', ')}) ---\n${parent.synthesis}`)
      .join('\n\n');

    const criticRotation = buildCriticRotation(pagePool);
    let nextCriticIndex = 0;

    const firstCritique = await executeRotatingCritique(
      runId,
      1,
      criticRotation,
      nextCriticIndex,
      pagePool,
      () => `${ROTATING_CRITIC_INSTRUCTION}\n\n` +
        `Below are partial syntheses of anonymized summaries from different subsets of sources. ` +
        `Each parent synthesis only saw its listed source labels; do not assume either parent synthesis had access to the other subset. ` +
        `Treat source labels only as attribution scaffolding, and do not discuss provider identity. ` +
        `Critique the combined topic-level substance across all parent syntheses, including tensions between parent syntheses where relevant. ` +
        `When describing a potential misrepresentation, specify the exact source label or parent synthesis whose wording needs checking rather than accusing an unnamed model.\n\n` +
        `${parentSynthesesText}`
    );
    nextCriticIndex = firstCritique.nextRotationIndex;

    let currentSocraticCritique = firstCritique.critique;
    let currentSocraticTaskId = firstCritique.taskId;
    let currentCriticProvider = firstCritique.provider;

    console.log(`\n🤖 [ROTATING DEFENSE] Piping tagged critique from [${currentCriticProvider.toUpperCase()}] back to answer models...`);
    const defensePromises = summaries.map(async (s, index) => {
      const provider = s.provider;
      const poolItem = ensurePoolItem(pagePool, provider);
      const defenseTaskId = `summary_task_${provider}_rotating_defense_${Date.now()}`;
      console.log(`\n🤖 [DEFENDER] Dispatching tagged critique back to [${provider.toUpperCase()}] in its active tab...`);

      const defensePrompt = `Evaluate the rotating critic's tagged critique against the substance of the claims. ` +
        `Respond to all the probing questions or points raised by the rotating critic, particularly those relevant to your claims, or refine/defend your position.\n\n` +
        `--- ALL ANONYMIZED SOURCE SUMMARIES FOR DISAGREEMENT CHECK ---\n` +
        `${buildSourceComparisonText(summaries, s.sourceLabel)}\n\n` +
        `--- TAGGED ROTATING CRITIQUE ---\n` +
        `${currentSocraticCritique}\n\n` +
        `${ROTATING_DEFENSE_INSTRUCTION}`;

      await new Promise((resolve) => setTimeout(resolve, index * 1000));

      const runner = new OrchestrationRunner(runId, defenseTaskId, provider);
      const defenseResponse = await runner.executeTask(defensePrompt, poolItem);
      console.log(`✅ [${provider.toUpperCase()}] completed its tagged defense/refinement.`);

      return {
        provider,
        sourceLabel: s.sourceLabel,
        taskId: defenseTaskId,
        parentTaskId: s.taskId,
        response: defenseResponse
      };
    });

    const defenseResults = await Promise.allSettled(defensePromises);
    const defenses: DefenseRecord[] = [];

    for (const res of defenseResults) {
      if (res.status === 'fulfilled') {
        defenses.push(res.value);
      } else {
        console.error(`❌ Rotating critic defense failed for provider: ${res.reason.message}`);
      }
    }

    if (defenses.length === 0) {
      throw new Error('All Answer models failed to respond to the rotating critique.');
    }

    const finalSynthesisProviders = selectSynthesisProviders(defenses.length);
    const defenseGroups = splitIntoBalancedGroups(defenses, finalSynthesisProviders.length);
    const assignedFinalSynthesisProviders = finalSynthesisProviders.slice(0, defenseGroups.length);
    console.log(`\n🤖 [AGGREGATORS] Splitting tagged defenses across rotating-critic refined synthesizers: ${assignedFinalSynthesisProviders.map(p => p.toUpperCase()).join(', ')}...`);
    const combinedDefensesText = defenses
      .map(d => `=== RESPONSE FROM [${d.sourceLabel}] ===\n${d.response}`)
      .join('\n\n');

    const buildRefinedSegments = (defenseGroup: DefenseRecord[]): string[] => {
      const refinedSegments: string[] = [];
      const refinedSysPrefix = `You are a neutral information synthesizer. I will now send you the parent syntheses that were critiqued, the tagged rotating critique, and only your assigned responses/defenses from anonymized sources (${defenseGroup.map(d => d.sourceLabel).join(', ')}). ` +
      `Other defenses are assigned to separate synthesizers; do not infer their content. ` +
      `Use the source labels only as stable attribution references. Do not discuss model identity or provider attribution. Please acknowledge each piece as I send it.\n\n`;

      refinedSegments.push(refinedSysPrefix + `--- PARENT SYNTHESES THAT WERE CRITIQUED ---\n${parentSynthesesText}`);
      refinedSegments.push(`--- TAGGED ROTATING CRITIQUE FROM [${currentCriticProvider.toUpperCase()}] ---\n${currentSocraticCritique}`);

      for (const d of defenseGroup) {
        refinedSegments.push(`=== RESPONSE/DEFENSE FROM [${d.sourceLabel}] ===\n${d.response}`);
      }

      refinedSegments.push(`${ROTATING_SYNTHESIS_INSTRUCTION}\n\n${SOURCE_DISAGREEMENT_SYNTHESIS_INSTRUCTION}`);
      return refinedSegments;
    };

    const finalSyntheses = await runGroupedDefenseSyntheses(
      runId,
      'summary_task_rotating_refined_synthesis',
      'ROTATING-CRITIC REFINED SYNTHESIS',
      assignedFinalSynthesisProviders,
      defenseGroups,
      buildRefinedSegments,
      pagePool
    );
    let currentRefinedSynthesis = formatSynthesisRecords(finalSyntheses);

    for (const synthesis of finalSyntheses) {
      await evaluateDefensesAgainstSynthesis({
        runId,
        roundNo: 1,
        summaryTaskId: synthesis.taskId,
        finalSynthesis: synthesis.synthesis,
        defenses: synthesis.defenses,
        pagePool
      });
    }

    console.log(`\n🔗 Linking lineage DAG edges (Initial Summaries -> Parent Syntheses -> Rotating Critic -> Defenses -> Refined Synthesis):`);
    for (const parent of parentSyntheses) {
      for (const s of summaries.filter(summary => parent.sourceLabels.includes(summary.sourceLabel))) {
        DBService.addLineage(s.taskId, parent.taskId);
      }
    }

    for (const parent of parentSyntheses) {
      DBService.addLineage(parent.taskId, currentSocraticTaskId);
    }

    for (const d of defenses) {
      DBService.addLineage(currentSocraticTaskId, d.taskId);
      DBService.addLineage(d.parentTaskId, d.taskId);
    }

    for (const synthesis of finalSyntheses) {
      for (const d of synthesis.defenses) {
        DBService.addLineage(d.taskId, synthesis.taskId);
      }
    }

    console.log('\n============================================================');
    console.log('       🎉 ROUND 1 ROTATING CRITIC DIALOGUE COMPLETE 🎉');
    console.log('============================================================');
    console.log('\n✨ PARENT SYNTHESES (Anonymized Parallel Reducers):');
    console.log('------------------------------------------------------------');
    console.log(parentSynthesesText);
    console.log('------------------------------------------------------------\n');
    console.log(`\n✨ TAGGED ROTATING CRITIQUE (From ${currentCriticProvider.toUpperCase()}):`);
    console.log('------------------------------------------------------------');
    console.log(currentSocraticCritique);
    console.log('------------------------------------------------------------\n');
    console.log('\n✨ TAGGED RESPONSES & DEFENSES FROM ANSWER MODELS:');
    console.log('------------------------------------------------------------');
    console.log(combinedDefensesText);
    console.log('------------------------------------------------------------\n');
    console.log('\n✨ ROTATING-CRITIC REFINED FINAL META-SYNTHESES (From Parallel Aggregators):');
    console.log('------------------------------------------------------------');
    console.log(currentRefinedSynthesis);
    console.log('------------------------------------------------------------\n');
    console.log(`Parent Synthesis Task IDs: ${parentSyntheses.map(parent => parent.taskId).join(', ')}`);
    console.log(`Rotating Critic Task ID: ${currentSocraticTaskId}`);
    console.log(`Refined Synthesis Task IDs: ${finalSyntheses.map(s => s.taskId).join(', ')}`);
    console.log('============================================================');
    console.log('To trace the logical aggregation lineage inside the database,');
    console.log('copy any Refined Synthesis Task ID and paste it into Menu Option 4 (Recursive Provenance).');
    console.log('============================================================\n');

    let round = 1;

    while (true) {
      round++;
      console.log(`\n============================================================`);
      console.log(`       🔄 STARTING ROTATING CRITIC ROUND ${round} 🔄`);
      console.log(`============================================================\n`);

      const critiqueResult = await executeRotatingCritique(
        runId,
        round,
        criticRotation,
        nextCriticIndex,
        pagePool,
        () => `${ROTATING_CRITIC_INSTRUCTION}\n\n` +
          `Below is the latest refined synthesis after the previous round of tagged rotating critique.\n\n` +
          `${currentRefinedSynthesis}\n\n` +
          `Provide a follow-up critique. Prefer new tags or new claim targets over repeating prior critiques unless the prior issue remains unresolved. Ask deeper, next-level probing questions, challenge remaining topic-level gaps, and preserve creative tension:`
      );

      currentSocraticCritique = critiqueResult.critique;
      currentSocraticTaskId = critiqueResult.taskId;
      currentCriticProvider = critiqueResult.provider;
      nextCriticIndex = critiqueResult.nextRotationIndex;

      console.log(`\n✨ TAGGED ROTATING CRITIQUE ROUND ${round} (From ${currentCriticProvider.toUpperCase()}):`);
      console.log('------------------------------------------------------------');
      console.log(currentSocraticCritique);
      console.log('------------------------------------------------------------\n');

      console.log(`\n🤖 [ROTATING DEFENSE] Piping new tagged critique to answer models...`);
      const roundDefensePromises = defenses.map(async (d, index) => {
        const provider = d.provider;
        const poolItem = ensurePoolItem(pagePool, provider);
        const roundDefenseTaskId = `summary_task_${provider}_rotating_defense_r${round}_${Date.now()}`;

        console.log(`\n🤖 [DEFENDER] Dispatching tagged critique back to [${provider.toUpperCase()}] in its active tab...`);

        const roundDefensePrompt = `Evaluate the rotating critic's tagged critique against the substance of the claims. ` +
          `Respond to all the probing questions or points raised by the rotating critic, particularly those relevant to your claims, or refine/defend your position.\n\n` +
          `--- TAGGED ROTATING CRITIQUE ---\n${currentSocraticCritique}\n\n` +
          `${ROTATING_DEFENSE_INSTRUCTION}`;

        await new Promise((resolve) => setTimeout(resolve, index * 1000));

        const runner = new OrchestrationRunner(runId, roundDefenseTaskId, provider);
        const defenseResponse = await runner.executeTask(roundDefensePrompt, poolItem);
        console.log(`✅ [${provider.toUpperCase()}] completed tagged defense/refinement for round ${round}.`);

        return {
          provider,
          sourceLabel: d.sourceLabel,
          taskId: roundDefenseTaskId,
          parentTaskId: d.taskId,
          response: defenseResponse
        };
      });

      const roundDefenseResults = await Promise.allSettled(roundDefensePromises);
      const newDefenses: DefenseRecord[] = [];

      for (const res of roundDefenseResults) {
        if (res.status === 'fulfilled') {
          newDefenses.push(res.value);
        } else {
          console.error(`❌ Rotating critic defense failed in round ${round}: ${res.reason.message}`);
        }
      }

      if (newDefenses.length === 0) {
        console.error('All Answer models failed to respond in this round. Ending loop.');
        break;
      }

      for (const nd of newDefenses) {
        DBService.addLineage(currentSocraticTaskId, nd.taskId);
        DBService.addLineage(nd.parentTaskId, nd.taskId);
      }

      defenses.length = 0;
      defenses.push(...newDefenses);

      const roundSynthesisProviders = selectSynthesisProviders(newDefenses.length);
      const roundDefenseGroups = splitIntoBalancedGroups(newDefenses, roundSynthesisProviders.length);
      const assignedRoundSynthesisProviders = roundSynthesisProviders.slice(0, roundDefenseGroups.length);
      console.log(`\n🤖 [AGGREGATORS] Splitting tagged defenses into round ${round} rotating-critic refined syntheses with ${assignedRoundSynthesisProviders.map(p => p.toUpperCase()).join(', ')}...`);
      const buildRoundSegments = (defenseGroup: DefenseRecord[]): string[] => {
        const roundSegments: string[] = [];
        const roundSysPrefix = `You are a neutral information synthesizer. I will now send you only your assigned responses/defenses from anonymized sources (${defenseGroup.map(d => d.sourceLabel).join(', ')}) to a tagged rotating critique. ` +
          `Other defenses are assigned to separate synthesizers; do not infer their content. ` +
          `Use the source labels only as stable attribution references. Do not discuss model identity or provider attribution. Please acknowledge each piece as I send it.\n\n`;

        roundSegments.push(roundSysPrefix + `--- TAGGED ROTATING CRITIQUE FROM [${currentCriticProvider.toUpperCase()}] ---\n${currentSocraticCritique}`);

        for (const d of defenseGroup) {
          roundSegments.push(`=== RESPONSE FROM [${d.sourceLabel}] ===\n${d.response}`);
        }

        roundSegments.push(`${ROTATING_SYNTHESIS_INSTRUCTION}\n\n${SOURCE_DISAGREEMENT_SYNTHESIS_INSTRUCTION}`);
        return roundSegments;
      };

      const roundFinalSyntheses = await runGroupedDefenseSyntheses(
        runId,
        `summary_task_rotating_refined_synthesis_r${round}`,
        `ROTATING-CRITIC REFINED SYNTHESIS ROUND ${round}`,
        assignedRoundSynthesisProviders,
        roundDefenseGroups,
        buildRoundSegments,
        pagePool
      );
      currentRefinedSynthesis = formatSynthesisRecords(roundFinalSyntheses);

      for (const synthesis of roundFinalSyntheses) {
        await evaluateDefensesAgainstSynthesis({
          runId,
          roundNo: round,
          summaryTaskId: synthesis.taskId,
          finalSynthesis: synthesis.synthesis,
          defenses: synthesis.defenses,
          pagePool
        });
      }

      for (const synthesis of roundFinalSyntheses) {
        for (const nd of synthesis.defenses) {
          DBService.addLineage(nd.taskId, synthesis.taskId);
        }
      }

      console.log('\n============================================================');
      console.log(`       🎉 ROUND ${round} ROTATING CRITIC DIALOGUE COMPLETE 🎉`);
      console.log('============================================================');
      console.log(`\n✨ ROTATING-CRITIC META-SYNTHESES ROUND ${round} (From Parallel Aggregators):`);
      console.log('------------------------------------------------------------');
      console.log(currentRefinedSynthesis);
      console.log('------------------------------------------------------------\n');
      console.log(`Rotating Critic Round ${round} Task ID: ${currentSocraticTaskId}`);
      console.log(`Refined Synthesis Round ${round} Task IDs: ${roundFinalSyntheses.map(s => s.taskId).join(', ')}`);
      console.log('Press CTRL-C at any time to terminate the rotating critic dialogue loop.');
      console.log('============================================================\n');

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

  } catch (err: any) {
    console.error(`❌ Rotating critic workflow failed: ${err.message}`);
    throw err;
  } finally {
    console.log('\n[INFO] Keeping active browser sessions open for visual inspection.\n');
  }
}
