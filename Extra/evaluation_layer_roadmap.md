# Evaluation Layer Development Roadmap

> [!NOTE]
> **Current Status (As of June 25, 2026):**
> - **Phase 0 (Baseline and Guardrails):** Completed. Config flags and baseline tests are verified.
> - **Phase 1 (MCP Tool-Call Metrics):** Completed. `McpToolCallMetrics` table and database routines are implemented. Handlers (`consult_council`, `consult_council_mcq`, `scout_discover_context`, and `materialize_validation_tests`) are wrapped with metrics recording. Unit and integration tests pass successfully.
> - **Next Up (Phase 2):** Implement typed context warning details.

This roadmap turns `Extra/evaluation_layer_design.md` into a concrete implementation plan for the Quorum LLM Council repository.

The first implementation should be deterministic, additive, and low-risk:

- Do not extend `summaryEvaluation.ts` or `SummaryEvaluationMetrics`.
- Do not make a successful council run fail because evaluation failed.
- Do not use detached background promises as durable post-hoc work.
- Preserve existing public fields such as `warnings: string[]`.
- Add LLM judges and embeddings only after deterministic metrics are implemented and tested.

---

## Target Outcomes

The evaluation layer should answer three questions:

1. How many Quorum MCP calls succeeded?
2. How well did the calling coding agent provide context?
3. How diverse and useful were the council members' thoughts?

The system should expose these answers through:

- SQLite metric records.
- A compact `evaluation` block in MCP structured responses where evaluation is available.
- A Markdown or JSON report artifact for deeper inspection.
- A later manual `evaluate_council_run` MCP tool for re-running evaluation on historical runs.

---

## Version Scope

### V1: Deterministic Inline Snapshot

V1 should run during `consult_council` without extra model calls. It should be cheap enough to execute inline.

Included:

- MCP tool-call metric recording.
- Provider/member success metrics.
- Typed context warning details, while preserving current warning strings.
- Intrinsic context quality metrics.
- Basic post-response context sufficiency metrics.
- Basic response diversity metrics using contract parsing and ROUGE.
- Persistence tables and DB service methods.
- Tests for all deterministic behavior.

Excluded:

- LLM-as-judge.
- Embedding similarity.
- Durable async worker.
- Weighted composite scores.
- Provider ranking claims.

### V1.1: Manual Post-Hoc Evaluation

Add a new MCP tool such as `evaluate_council_run` that evaluates a completed run by reading persisted tasks and context metadata.

Included:

- Re-run evaluation for past runs.
- Persist a new `CouncilEvaluationRuns` row for each evaluation execution.
- Return evaluation artifacts without changing the original council run status.

### V2: Durable Post-Hoc and Semantic Evaluation

Only after V1 and V1.1 are stable:

- Add durable queue or DAG-backed evaluation execution.
- If a `PENDING` evaluation row is created before returning a tool response, a durable worker or explicit manual resume path must own it.
- Add optional LLM judge with strict JSON output.
- Add optional embeddings with frozen model/version metadata.
- Add calibration set and human-labeled benchmark workflow.

---

## Repository Touch Points

Expected files to add:

```text
from_orchestrator/engine/evaluation/
  types.ts
  contextQuality.ts
  responseDiversity.ts
  findingExtraction.ts
  evaluationRunner.ts
  metrics.ts
```

Expected files to modify:

```text
from_orchestrator/db/database.ts
from_orchestrator/mcp/contextValidation.ts
from_orchestrator/mcp/server.ts
from_orchestrator/mcp/reportArtifact.ts
from_orchestrator/engine/council.ts
from_orchestrator/engine/mcq.ts
from_orchestrator/engine/councilDebate.ts
from_orchestrator/config/index.ts
tests/contextValidation.test.ts
tests/council.test.ts
```

Expected tests to add:

```text
tests/evaluationContextQuality.test.ts
tests/evaluationDiversity.test.ts
tests/evaluationPersistence.test.ts
tests/mcpToolMetrics.test.ts
```

---

## Data Model

### 1. `McpToolCallMetrics`

Purpose: count MCP-level success and failure, including validation failures that may not create a council run.

```sql
CREATE TABLE IF NOT EXISTS McpToolCallMetrics (
  tool_call_id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  run_id TEXT REFERENCES Runs(run_id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN (
    'RECEIVED',
    'VALIDATION_FAILED',
    'COMPLETED',
    'PARTIAL_SUCCESS',
    'FAILED',
    'CANCELLED',
    'INTERVENTION_REQUIRED'
  )),
  requested_provider_count INTEGER DEFAULT 0,
  successful_provider_count INTEGER DEFAULT 0,
  failed_provider_count INTEGER DEFAULT 0,
  duration_ms INTEGER,
  context_digest TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_mcp_tool_metrics_tool_status
ON McpToolCallMetrics(tool_name, status);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_metrics_run_id
ON McpToolCallMetrics(run_id);
```

### 2. `CouncilEvaluationRuns`

Purpose: one row per evaluation execution.

```sql
CREATE TABLE IF NOT EXISTS CouncilEvaluationRuns (
  evaluation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
  tool_call_id TEXT REFERENCES McpToolCallMetrics(tool_call_id) ON DELETE SET NULL,
  evaluation_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'COMPLETED', 'PARTIAL', 'SKIPPED', 'FAILED')),
  mode TEXT NOT NULL CHECK(mode IN ('council', 'debate', 'mcq')),
  context_digest TEXT,
  trigger TEXT NOT NULL CHECK(trigger IN ('inline', 'manual', 'posthoc')),
  evaluator_provider TEXT,
  evaluator_task_id TEXT,
  config_json TEXT,
  error_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);
```

Recommended uniqueness:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_council_eval_unique_inline
ON CouncilEvaluationRuns(run_id, evaluation_version, trigger)
WHERE trigger = 'inline';
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_council_eval_runs_run_id
ON CouncilEvaluationRuns(run_id);

CREATE INDEX IF NOT EXISTS idx_council_eval_runs_tool_call_id
ON CouncilEvaluationRuns(tool_call_id);

CREATE INDEX IF NOT EXISTS idx_council_eval_runs_run_status
ON CouncilEvaluationRuns(run_id, status, completed_at);
```

Relationship and latest semantics:

- `Runs` to `CouncilEvaluationRuns` is one-to-many: manual re-runs, new evaluation versions, and future judge configurations should create distinct evaluation executions.
- Do not add a global unique constraint on `run_id`.
- For V1, derive latest evaluation by `completed_at DESC, created_at DESC` scoped to `(run_id, mode)` or `(run_id, mode, evaluation_version)`.
- Add `is_latest` only if a later UI/query path needs it; if added, enforce it with a partial unique index such as `UNIQUE(run_id, mode) WHERE is_latest = 1`.

### 3. `ContextQualityMetrics`

Purpose: store intrinsic and hindsight context metrics. Hindsight fields should be nullable when no responses are available.

```sql
CREATE TABLE IF NOT EXISTS ContextQualityMetrics (
  evaluation_id TEXT PRIMARY KEY REFERENCES CouncilEvaluationRuns(evaluation_id) ON DELETE CASCADE,
  warning_count INTEGER NOT NULL DEFAULT 0,
  missing_import_count INTEGER NOT NULL DEFAULT 0,
  referenced_file_coverage REAL,
  structured_field_coverage REAL,
  structured_review_density REAL,
  notes_present INTEGER NOT NULL DEFAULT 0 CHECK(notes_present IN (0, 1)),
  notes_length INTEGER NOT NULL DEFAULT 0,
  evidence_relevance_coverage REAL,
  excerpt_ratio REAL,
  project_scaffolding_coverage REAL,
  context_size_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  duplicate_content_count INTEGER NOT NULL DEFAULT 0,
  supported_finding_rate REAL,
  unsupported_specific_claim_rate REAL,
  missing_context_request_rate REAL,
  repeated_missing_dependency_count INTEGER,
  unused_evidence_rate REAL,
  evidence_concentration REAL,
  metrics_json TEXT
);
```

`evaluation_id` is the primary key, so SQLite already indexes this child foreign key. Do not add a duplicate index unless the table changes to one-to-many rows per evaluation.

### 4. `CouncilDiversityMetrics`

Purpose: aggregate diversity metrics for a council run.

```sql
CREATE TABLE IF NOT EXISTS CouncilDiversityMetrics (
  evaluation_id TEXT PRIMARY KEY REFERENCES CouncilEvaluationRuns(evaluation_id) ON DELETE CASCADE,
  member_count INTEGER NOT NULL DEFAULT 0,
  valid_response_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  finding_parse_failure_count INTEGER NOT NULL DEFAULT 0,
  finding_cluster_count INTEGER NOT NULL DEFAULT 0,
  unique_finding_ratio REAL,
  consensus_cluster_rate REAL,
  redundancy_rate REAL,
  contradiction_pair_count INTEGER NOT NULL DEFAULT 0,
  mean_pairwise_rouge1 REAL,
  mean_pairwise_rouge2 REAL,
  mean_pairwise_rouge_l REAL,
  max_pairwise_rouge_l REAL,
  category_entropy REAL,
  classification_entropy REAL,
  severity_entropy REAL,
  evidence_path_breadth INTEGER NOT NULL DEFAULT 0,
  provider_incremental_coverage_json TEXT,
  metrics_json TEXT
);
```

`evaluation_id` is the primary key, so SQLite already indexes this child foreign key. Do not add a duplicate index unless the table changes to one-to-many rows per evaluation.

Metric storage rule:

- Keep operational fields and stable, commonly filtered scorecard fields as columns.
- Store volatile, experimental, provider-specific, or high-cardinality metric details in `metrics_json`.
- When a JSON metric becomes a frequent filter/sort key, add a SQLite expression index or generated column explicitly.

### 5. Optional Detail Tables

Add only after aggregate metrics are useful:

- `CouncilResponsePairMetrics`
- `CouncilFindingClusters`
- `CouncilFindingMembership`
- `CouncilContextEvidenceUsage`

Do not store an evaluation report in `Artifacts` until the `artifact_type` check constraint is intentionally expanded. For V1, use report files under `quorum/` or put structured detail in `metrics_json`.

---

## Public Types

Add `from_orchestrator/engine/evaluation/types.ts`.

```ts
export type EvaluationMode = 'council' | 'debate' | 'mcq';
export type EvaluationTrigger = 'inline' | 'manual' | 'posthoc';
export type EvaluationStatus = 'PENDING' | 'COMPLETED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';

export type CouncilEvaluationInput = {
  runId: string;
  toolCallId?: string;
  mode: EvaluationMode;
  trigger: EvaluationTrigger;
  question: string;
  contextDigest?: string;
  context?: ValidatedCouncilContext;
  requestedProviders: string[];
  analyses?: CouncilAnalysis[];
  voteDistribution?: McqVoteDistribution;
  debateTurns?: CouncilDebateTurn[];
};

export type CouncilEvaluationResult = {
  evaluation_id: string;
  evaluation_version: string;
  status: EvaluationStatus;
  mode: EvaluationMode;
  call?: McpToolCallSummary;
  context_quality?: ContextQualityScorecard;
  diversity?: CouncilDiversityScorecard;
  warnings: string[];
};
```

Keep result objects scorecard-style. Do not add one opaque "quality score" in V1.

---

## Phase Plan

## Phase 0: Baseline and Guardrails

Goal: confirm current tests pass and document the non-goals.

Tasks:

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Add config flags:
  - `ENABLE_COUNCIL_EVALUATION`
  - `COUNCIL_EVALUATION_MODE`
  - `COUNCIL_EVALUATION_VERSION`
- [x] Default evaluation to enabled for deterministic inline metrics only, or disabled if you want zero behavior change before integration.

Definition of done:

- [x] Existing tests pass.
- [x] No existing output fields are removed or renamed.

## Phase 1: MCP Tool-Call Metrics

Goal: record the number of successful and failed Quorum MCP calls.

Implementation:

- [x] Add `McpToolCallMetrics` schema to `initSchema()`.
- [x] Add DB methods:
  - `createMcpToolCallMetric(params)`
  - `completeMcpToolCallMetric(params)`
  - `failMcpToolCallMetric(params)`
  - `getMcpToolCallMetrics(params?)`
- [x] In `server.ts`, create a `tool_call_id` before validating `consult_council` and `consult_council_mcq` (and also cover `scout_discover_context` and `materialize_validation_tests`).
- [x] On validation failure, record `VALIDATION_FAILED`.
- [x] On completed result, record:
  - `COMPLETED` or `PARTIAL_SUCCESS`
  - requested provider count
  - successful provider count
  - failed provider count
  - duration
  - context digest where available

Tests:

- [x] Invalid context produces a failed tool-call metric without a run.
- [x] Unsupported provider produces a failed metric and does not create a run.
- [x] Mock council success records `COMPLETED`.
- [x] Partial provider failure records `PARTIAL_SUCCESS`.

Definition of done:

- [x] MCP success can be queried independently from provider/member success.

## Phase 2: Typed Context Warning Details

Goal: make context warning metrics reliable without parsing human strings.

Implementation:

- [ ] Add a new type in `contextValidation.ts`:

```ts
export type CouncilContextWarning = {
  code:
    | 'structured_review_optional'
    | 'duplicate_content_hash'
    | 'stale_mtime'
    | 'missing_local_import'
    | 'missing_project_config'
    | 'referenced_file_missing'
    | 'structured_reference_missing'
    | 'omitted_material_included'
    | 'missing_disk_file';
  message: string;
  path?: string;
  referencedPath?: string;
  sourcePath?: string;
  field?: string;
  metadata?: Record<string, unknown>;
};
```

- [ ] Extend `ValidatedCouncilContext` with:

```ts
warnings: string[];
warning_details: CouncilContextWarning[];
```

- [ ] Preserve every existing warning string.
- [ ] Refactor warning sites to push both string and structured detail.

Tests:

- [ ] Existing `contextValidation.test.ts` assertions still pass.
- [ ] New assertions verify stable `warning_details.code` values.
- [ ] Duplicate content, missing import, missing config, stale mtime, and structured reference warnings are typed.

Definition of done:

- [ ] No caller is forced to migrate from `warnings`.
- [ ] Metrics code can aggregate warning details without regexes.

## Phase 3: Intrinsic Context Quality Metrics

Goal: evaluate how well the caller supplied context before model responses are considered.

Implementation:

- Add `contextQuality.ts`.
- Implement:
  - `evaluateIntrinsicContextQuality(input)`
  - `countWarningCodes(warningDetails)`
  - `referencedFileCoverage(question, context)`
  - `structuredReviewCoverage(context)`
  - `evidenceRelevanceCoverage(context)`
  - `projectScaffoldingCoverage(context)`
- Add `ContextQualityMetrics` schema and DB methods.

Metrics:

- warning counts by code
- missing local imports
- referenced file coverage
- structured review field coverage
- structured review density
- notes present and length
- evidence relevance coverage
- excerpt ratio
- context size
- file count
- duplicate content count
- project scaffolding coverage

Tests:

- Full context with structured review scores high on structural fields.
- Context missing imports reports missing import count.
- Notes are recorded descriptively but do not imply quality alone.
- Empty optional structured review produces expected coverage without throwing when not required.

Definition of done:

- Intrinsic metrics can be computed immediately after `validateCouncilContext`.
- Metrics do not use any council member response.

## Phase 4: Evaluation Run Persistence

Goal: create a versioned evaluation execution record and persist context metrics.

Implementation:

- Add `CouncilEvaluationRuns`.
- Add DB methods:
  - `createCouncilEvaluationRun(params)`
  - `completeCouncilEvaluationRun(params)`
  - `failCouncilEvaluationRun(params)`
  - `createContextQualityMetric(params)`
  - `getCouncilEvaluation(runId)`
- Add `evaluationRunner.ts` with:

```ts
export function evaluateCouncilRun(input: CouncilEvaluationInput): CouncilEvaluationResult
```

- For V1, allow `evaluateCouncilRun` to compute only metrics for which inputs exist.

Tests:

- Creating an evaluation run and context metric is transactional.
- Duplicate inline evaluation for the same run/version is idempotent or explicitly rejected.
- Failure in detail insertion marks evaluation failed or rolls back consistently.

Definition of done:

- Every persisted metric row ties back to an `evaluation_id` and `run_id`.
- Evaluation status is independent of run status.
- Non-primary-key foreign keys used for joins have explicit indexes.
- Latest evaluation reads are deterministic without requiring `run_id` to be unique.

## Phase 5: Inline Council Integration

Goal: attach deterministic evaluation to `consult_council` without changing success semantics.

Implementation:

- In `server.ts`, pass `toolCallId` into `runCouncilConsultation` or attach evaluation after result returns.
- In `council.ts`, preserve the normal result path.
- After analyses are available, `await evaluateCouncilRun` before returning the MCP tool response.
- Catch evaluation errors and turn them into evaluation warnings instead of throwing from the council request.
- Add optional result field:

```ts
evaluation?: {
  evaluation_id: string;
  evaluation_version: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  call: {
    requested_provider_count: number;
    successful_provider_count: number;
    failed_provider_count: number;
  };
  context_quality?: ContextQualityScorecard;
  diversity?: CouncilDiversityScorecard;
};
```

Tests:

- Evaluation failure does not change `result.status`.
- Mock council returns an `evaluation` block when enabled.
- Evaluation can be disabled by config.

Definition of done:

- `consult_council` reports evaluation data without making evaluation a critical path failure.
- No detached promises or process-lifetime background work are used for V1 evaluation.
- Inline evaluation returns only after persisting a terminal evaluation status; it does not leave `PENDING` work behind.

## Phase 6: Finding Extraction MVP

Goal: convert raw member responses into normalized findings for context sufficiency and diversity.

Implementation:

- Add `findingExtraction.ts`.
- Implement deterministic parser for the reviewer contract sections.
- Extract:
  - classification
  - severity
  - confidence
  - evidence path and line ranges
  - claim
  - reasoning
  - missing context
  - validation test
- Store parse failures as data, not thrown errors.
- Keep original response untouched.

Parser fallback strategy:

- V1: mark malformed responses with parse failure and use coarse response-level lexical metrics.
- V2: optional LLM extractor can normalize malformed responses.

Tests:

- Well-formed finding parses correctly.
- Multiple findings parse into separate records.
- Missing evidence is reported as parse warning.
- Malformed response does not crash evaluation.

Definition of done:

- The diversity layer can operate on normalized findings when available.

## Phase 7: Response Diversity MVP

Goal: report useful diversity metrics without embeddings or LLM judges.

Implementation:

- Add `responseDiversity.ts`.
- Reuse `calculateRouge` from `from_orchestrator/engine/rouge.ts`.
- Strip:
  - repeated reviewer headings
  - contract labels
  - large quoted source snippets
  - repeated evidence boilerplate
- Compute:
  - pairwise ROUGE-1, ROUGE-2, ROUGE-L
  - mean and max pairwise similarity
  - finding count
  - parse failure count
  - evidence path breadth
  - classification entropy
  - severity entropy
  - category entropy where categories can be inferred
- Add simple clustering:
  - same normalized classification
  - overlapping evidence path/range
  - high lexical overlap between claims
- Report consensus and novelty separately.

Tests:

- Identical responses have high similarity.
- Same finding with paraphrased wording clusters when evidence overlaps.
- Different findings sharing one evidence file remain separate when claims differ.
- Agreement does not reduce novelty metrics without being labeled as a failure.
- Empty or one-member councils do not produce `NaN`.

Definition of done:

- V1 can distinguish duplicate responses, consensus findings, and unique contributions at a basic level.

## Phase 8: Hindsight Context Metrics

Goal: evaluate whether supplied context supported the findings reviewers actually made.

Implementation:

- Extend `contextQuality.ts` with:
  - `evaluateHindsightContextQuality(context, findings)`
- Compute:
  - supported finding rate
  - unsupported specific claim rate
  - missing context request rate
  - repeated missing dependency count
  - unused evidence rate
  - evidence concentration
- Resolve evidence references only against supplied context paths and line ranges.

Tests:

- Finding with supplied `path:line` evidence counts as supported.
- Finding citing omitted file counts as unsupported or missing context.
- Two members asking for the same missing dependency increments repeated missing dependency count.
- Supplied but never cited evidence contributes to unused evidence rate.

Definition of done:

- Intrinsic and hindsight context metrics are stored separately and not double-counted.

## Phase 9: Report Surfacing

Goal: make evaluation visible without cluttering the primary council report.

Implementation:

- Add a concise `## Evaluation` section to report artifacts.
- Include:
  - MCP call status
  - requested/successful/failed provider counts
  - context warning count by code
  - top context risks
  - diversity summary
  - evaluation status
- Save a JSON detail file under `quorum/`, for example:

```text
quorum/evaluation_<run_id>.json
```

- Do not add a new `Artifacts.artifact_type` until schema migration is planned.

Tests:

- Artifact includes evaluation section when evaluation exists.
- Artifact omits or marks evaluation as skipped when disabled.
- JSON detail file is valid JSON.

Definition of done:

- Humans can inspect evaluation without querying SQLite manually.

## Phase 10: Manual `evaluate_council_run` MCP Tool

Goal: re-run evaluation on historical runs and avoid fake async execution.

Implementation:

- Add MCP tool:

```ts
evaluate_council_run({
  run_id: string,
  mode?: 'council' | 'debate' | 'mcq',
  evaluation_version?: string,
  include_llm_judge?: boolean
})
```

- Load:
  - `Runs`
  - `Tasks`
  - context digest and context metadata if persisted
  - previous evaluation records
- If full original context is not persisted, return partial evaluation with an explicit limitation.

Required prerequisite:

- Persist enough context metadata during `consult_council` to evaluate later:
  - `context_digest`
  - file paths, roles, ranges, hashes
  - warning details
  - optionally full validated context, if privacy policy permits

Tests:

- Existing run can be evaluated manually.
- Missing context metadata produces `PARTIAL`, not a crash.
- Re-running with same version is idempotent or creates a clearly separate manual evaluation.

Definition of done:

- Historical runs can be evaluated without relying on process-lifetime background tasks.

## Phase 11: MCQ and Debate Evaluation

Goal: support non-default modes without forcing one diversity definition onto all modes.

MCQ metrics:

- vote entropy
- effective option count
- majority concentration
- unanimity rate
- invalid response rate
- abstention rate
- rationale diversity separate from vote diversity

Debate metrics:

- initial analysis diversity
- critique novelty
- rebuttal update rate
- convergence delta
- independent persistence into final decision

Tests:

- Unanimous MCQ with distinct rationales is not treated as low rationale diversity.
- Split MCQ with copied rationales reports choice diversity but low rationale diversity.
- Debate decision convergence does not reduce initial-analysis diversity.

Definition of done:

- `mode` controls which metrics are computed and how they are interpreted.

## Phase 12: Optional LLM Judge and Embeddings

Goal: add semantic evaluation only after deterministic metrics are stable.

Implementation requirements:

- Use provider not in evaluated council where feasible.
- Blind provider identity.
- Randomize response order.
- Use narrow JSON rubrics.
- Persist:
  - judge provider
  - evaluator task id
  - prompt version
  - raw JSON
  - rationale
  - model/version if available
- Never use judge score as sole gate.

Tests:

- Judge output parser handles malformed JSON.
- Member order randomization does not materially change calibrated fixture scores.
- Judge failure produces partial evaluation, not failed council run.

Definition of done:

- LLM judge is optional, auditable, and calibrated against fixtures.

---

## Configuration

Add to `config/index.ts`:

```ts
enableCouncilEvaluation: process.env.ENABLE_COUNCIL_EVALUATION !== 'false',
councilEvaluationMode: process.env.COUNCIL_EVALUATION_MODE || 'inline',
councilEvaluationVersion: process.env.COUNCIL_EVALUATION_VERSION || 'deterministic-v1',
enableCouncilLlmJudge: process.env.ENABLE_COUNCIL_LLM_JUDGE === 'true',
councilJudgeProvider: process.env.COUNCIL_JUDGE_PROVIDER || process.env.EVALUATOR_PROVIDER || 'gemini'
```

Allowed modes for V1:

- `inline`
- `disabled`

Reserve `posthoc` until a durable worker or manual tool exists.

---

## Testing Matrix

### Unit Tests

- Context warning detail construction.
- Intrinsic context metrics.
- Finding parser.
- ROUGE preprocessing.
- Entropy and ratio helpers.
- Pairwise diversity for 0, 1, 2, and 3 responses.

### Integration Tests

- Mock council success with evaluation enabled.
- Mock council success with evaluation disabled.
- Partial provider failure.
- Invalid context failure.
- Evaluation persistence and retrieval.
- Report artifact generation.

### Regression Tests

- Existing `summaryEvaluation.ts` behavior unchanged.
- Existing `SummaryEvaluationMetrics` tests unchanged.
- Existing `warnings` string assertions unchanged.
- Existing council and MCQ result status behavior unchanged.

Run:

```bash
npm test
npm run typecheck
```

---

## Acceptance Criteria for V1

V1 is complete when:

- MCP tool-call success can be counted from SQLite.
- Provider/member success can be counted for each council run.
- Context metrics are deterministic and persisted.
- `warnings: string[]` remains backward compatible.
- `warning_details` exists for reliable metric aggregation.
- Diversity metrics are computed without LLM calls.
- Evaluation failure does not alter council run status.
- Evaluation can be disabled by configuration.
- Tests cover success, partial success, invalid input, malformed responses, and one-member councils.
- No changes are made to `summaryEvaluation.ts` semantics or `SummaryEvaluationMetrics`.

---

## Open Decisions

1. Should full validated context be persisted for historical evaluation, or only metadata?
2. Should inline evaluation be enabled by default or gated behind `ENABLE_COUNCIL_EVALUATION=true` until stable?
3. Should manual `evaluate_council_run` create a new evaluation row every time, or deduplicate by `(run_id, evaluation_version, trigger)`?
4. Should report artifacts include only summary metrics or also link to JSON detail files?
5. Should latest evaluation remain timestamp-derived, or does a UI/query path need an enforced `is_latest` flag?
6. What minimum parse compliance should be required before using finding-level metrics instead of response-level metrics?
7. What human-labeled fixture set will be used before adding LLM judge scores?

---

## Recommended First Pull Request

Keep the first PR narrow:

1. Add `McpToolCallMetrics`.
2. Add DB service methods for tool-call metrics.
3. Wrap `consult_council` and `consult_council_mcq` handlers with metric recording.
4. Add tests for successful, partial, validation-failed, and unsupported-provider calls.

This first PR delivers one of the original goals immediately: a reliable count of successful Quorum MCP calls. It also creates a safe foundation for the context and diversity work that follows.
