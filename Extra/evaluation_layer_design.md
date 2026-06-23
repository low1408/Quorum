# Evaluation Layer Design — Council Report

> **Run ID:** `council_run_1782197368017_69c15d0e`
> **Status:** COMPLETED (3/3 providers: ChatGPT, Claude, Qwen)
> **Individual reports:** [quorum/council_report.md](file:///home/harry/Documents/Github-Projects/personal-projects/quorum-llm-council/quorum/council_report.md)

---

## 1. Architecture: Separate Evaluation Package

> [!IMPORTANT]
> All three council members agree: **do NOT extend `summaryEvaluation.ts` or `SummaryEvaluationMetrics`**. Context quality and response diversity are run-level evaluations, not defender-to-summary comparisons.

**Recommended structure:**

```
from_orchestrator/engine/evaluation/
  types.ts                  # Shared types, scores, configs
  contextQuality.ts         # Intrinsic + hindsight context metrics
  responseDiversity.ts      # Pairwise similarity, clustering, coverage
  findingExtraction.ts      # Parse structured findings from responses
  evaluationRunner.ts       # Orchestration entry point
```

**Public API boundary:**

```typescript
evaluateCouncilRun({
  runId: string,
  mode: 'council' | 'debate' | 'mcq',
  question: string,
  context: ValidatedCouncilContext,
  analyses: CouncilAnalysis[],
  voteDistribution?: McqVoteDistribution,
  debateTurns?: CouncilDebateTurn[]
})
```

---

## 2. Context Quality Metrics

> [!TIP]
> The council strongly recommends separating **intrinsic** (pre-dispatch) metrics from **hindsight** (post-response) metrics to avoid information leakage.

### Intrinsic Deterministic Metrics (compute at validation time, no LLM needed)

| Metric | Description |
|--------|-------------|
| `validation_warning_count` | Grouped by warning type |
| `missing_local_import_count` | From existing `addCompletenessWarnings()` |
| `referenced_file_coverage` | Files named in question that were supplied |
| `structured_review_field_coverage` | Populated fields / 9 |
| `structured_review_density` | Non-placeholder content per field |
| `notes_present` + `notes_length` | Descriptive, not quality-scored |
| `evidence_relevance_coverage` | Files with non-empty relevance / total files |
| `excerpt_ratio` | Excerpt files / total files |
| `project_scaffolding_coverage` | package.json, tsconfig.json, etc. present |
| `context_size_bytes`, `file_count` | Size metrics |
| `context_digest` | Immutable evaluation input identifier |

### Hindsight Post-Response Metrics (compute after council responses)

| Metric | Description |
|--------|-------------|
| `supported_finding_rate` | Findings with exact evidence resolving to supplied files |
| `unsupported_specific_claim_rate` | Technical claims without supplied evidence |
| `missing_context_request_rate` | Findings explicitly marked as lacking context |
| `repeated_missing_dependency_count` | Dependencies requested by ≥2 members |
| `unused_evidence_rate` | Supplied files never cited by any response |
| `evidence_concentration` | Share of findings using the most-cited source |

> [!WARNING]
> Qwen raises a key point: the existing `warnings[]` are plain strings, not structured objects. Refactoring `contextValidation.ts` to return typed warning objects (e.g., `{ type: 'missing_import', path: string }`) would enable reliable aggregation without regex parsing.

---

## 3. Diversity of Thought Metrics

### Step 1: Extract Normalized Findings

Before computing diversity, **parse responses into structured findings**:

```typescript
{
  classification: string,    // e.g., "Architectural risk"
  severity: string,          // e.g., "High"
  evidencePaths: string[],   // e.g., ["council.ts:23-29"]
  issueCategory: string,     // e.g., "architecture", "security"
  claim: string,             // The core concern
  recommendedAction: string,
  missingContext: string,
  validationTestCategory: string
}
```

Use deterministic contract parsing first. LLM extractor as fallback only for malformed responses.

### Step 2: Compute Metrics

#### Lexical & Semantic Overlap

| Metric | Description |
|--------|-------------|
| Pairwise ROUGE-1/2/L | **After stripping** contract boilerplate + quoted evidence |
| Pairwise embedding cosine | Optional, if embedding provider available |
| Similarity matrix | Full pairwise, not just mean |

#### Finding Uniqueness

| Metric | Description |
|--------|-------------|
| `unique_finding_ratio` | Distinct finding clusters / total findings |
| `member_novelty_rate` | Clusters unique to one member / that member's findings |
| `redundancy_rate` | Findings already raised by another member |
| `consensus_cluster_rate` | Clusters raised by ≥ configured % of members |
| `contradiction_pair_count` | Materially incompatible recommendations |

#### Coverage Breadth

| Metric | Description |
|--------|-------------|
| Category entropy | Over issue categories (architecture, security, testing, etc.) |
| Evidence-path breadth | How many source files are referenced |
| Classification/severity entropy | Distribution diversity |

#### Provider Differentiation

| Metric | Description |
|--------|-------------|
| Provider incremental coverage | New clusters when adding a provider |
| Leave-one-out coverage loss | Coverage drop when removing a provider |
| Provider-exclusive category rate | Categories only one provider surfaces |

> [!NOTE]
> **Agreement ≠ groupthink.** Independent convergence on evidence-backed findings is consensus, not necessarily a problem. Report both consensus and novelty.

---

## 4. Mode-Specific Evaluation

### Council Debate

- Measure primary diversity in **analysis phase only**
- `critique_novelty`: new clusters introduced during critique
- `rebuttal_update_rate`: claims changed after criticism
- `convergence_delta`: similarity change analysis → decision
- `independent_persistence`: unique findings retained through final decision

### MCQ Voting

- **Vote entropy** and **effective number of options** (`exp(entropy)`)
- Majority concentration, unanimity rate, abstention rate
- **Rationale diversity separately from choice diversity** — unanimous votes with distinct rationales ≠ low diversity

---

## 5. Persistence: New DB Tables

### `CouncilEvaluationRuns`
```sql
evaluation_id TEXT PRIMARY KEY,
run_id TEXT NOT NULL REFERENCES Runs(run_id),
evaluation_version TEXT NOT NULL,
status TEXT NOT NULL,    -- PENDING | COMPLETED | PARTIAL | SKIPPED | FAILED
mode TEXT NOT NULL,      -- council | debate | mcq
context_digest TEXT,
started_at TIMESTAMP,
completed_at TIMESTAMP,
trigger TEXT,            -- inline | posthoc | manual
evaluator_provider TEXT,
evaluator_task_id TEXT,
config_json TEXT,
error_json TEXT
```

Relationship:

- `Runs` to `CouncilEvaluationRuns` is one-to-many. A run may be evaluated multiple times with different evaluation versions, triggers, or future judge configurations.
- Do not make `run_id` globally unique. Deduplicate narrowly, such as `(run_id, evaluation_version, trigger)` for inline evaluation if repeat inline evaluation should be idempotent.
- The latest/active evaluation should be derived from timestamps for V1, or represented later with an explicit `is_latest` invariant if a UI or query path needs it.

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_council_eval_runs_run_id
ON CouncilEvaluationRuns(run_id);

CREATE INDEX IF NOT EXISTS idx_council_eval_runs_run_status
ON CouncilEvaluationRuns(run_id, status, completed_at);
```

### `ContextQualityMetrics`
```sql
evaluation_id TEXT PRIMARY KEY REFERENCES CouncilEvaluationRuns(evaluation_id),
warning_count INTEGER, missing_import_count INTEGER,
referenced_file_coverage REAL, structured_field_coverage REAL,
evidence_relevance_coverage REAL, excerpt_ratio REAL,
project_scaffolding_coverage REAL,
supported_finding_rate REAL,     -- nullable (hindsight)
missing_context_request_rate REAL,
unused_evidence_rate REAL,
metrics_json TEXT                 -- extensible overflow
```

`evaluation_id` is a primary key here, so SQLite already indexes it. Add a separate foreign-key index only if this table later changes to one-to-many rows per evaluation.

### `CouncilDiversityMetrics`
```sql
evaluation_id TEXT PRIMARY KEY REFERENCES CouncilEvaluationRuns(evaluation_id),
member_count INTEGER, valid_response_count INTEGER,
finding_count INTEGER, finding_cluster_count INTEGER,
unique_finding_ratio REAL, consensus_cluster_rate REAL,
mean_pairwise_rouge1 REAL, mean_pairwise_rouge2 REAL, mean_pairwise_rouge_l REAL,
mean_semantic_similarity REAL,   -- nullable
category_entropy REAL, evidence_path_breadth INTEGER,
provider_incremental_coverage_json TEXT,
metrics_json TEXT
```

`evaluation_id` is also a primary key here and does not need a duplicate foreign-key index.

Metric storage rule:

- Keep operational fields and stable, commonly filtered scorecard fields as columns.
- Put volatile, experimental, provider-specific, or high-cardinality details in `metrics_json`.
- If a JSON metric becomes a hot query path, add an expression index or generated column intentionally rather than promoting every metric to a column by default.

### Optional Detail Tables
- `CouncilResponsePairMetrics` — per task-pair ROUGE/similarity
- `CouncilFindingClusters` — normalized finding clusters
- `CouncilFindingMembership` — cluster ↔ task mapping
- `CouncilContextEvidenceUsage` — finding ↔ evidence ID mapping

---

## 6. Execution Strategy

> [!IMPORTANT]
> **Inline deterministic evaluation by default.** Quorum runs as an MCP server, and MCP clients may suspend or terminate the server process as soon as the tool response is returned. Do not rely on fire-and-forget promises or process-lifetime background work for evaluation persistence.

The V1 evaluation path should be synchronous from the MCP tool's perspective: after council responses are persisted, run the cheap deterministic evaluation steps, persist their status, then return the tool response. Evaluation errors must not fail an otherwise successful consultation; catch them, persist `FAILED` or `PARTIAL` evaluation status where possible, and include an evaluation warning in the response.

For inline evaluation, prefer computing metrics first and persisting the evaluation row with a terminal status (`COMPLETED`, `PARTIAL`, `FAILED`, or `SKIPPED`) in the same awaited path. `PENDING` should be reserved for durable queued work that has a worker or manual resume path.

### Recommended execution flow:

```mermaid
graph TD
    A[MCP Request] --> B[Context Validation]
    B --> C["Intrinsic Snapshot (cheap, deterministic)"]
    C --> D[Council Execution]
    D --> E[Persist Responses]
    E --> F["Inline Evaluation (blocking)"]
    F --> G[Finding Extraction]
    F --> H[Pairwise ROUGE]
    F --> I[Clustering]
    G & H & I --> J[Persist Evaluation Metrics]
    J --> K["Return Report ✅"]
```

- Supported V1 modes: `evaluationMode: 'inline' | 'disabled'`
- Reserve `posthoc` for a future durable worker/queue or explicit manual MCP tool such as `evaluate_council_run`
- If `posthoc` is added, it must enqueue durable work before returning; it must not schedule detached JavaScript promises
- Inline evaluation must not return a tool response after writing only `PENDING`
- Optional LLM judge evaluation belongs outside the V1 inline path unless it is explicitly requested and acceptable as blocking work
- Evaluation status (`PENDING`/`COMPLETED`/`FAILED`) is independent of consultation status

---

## 7. Meta-Circularity: LLM-as-Judge Guardrails

**Hierarchy of authority (most trusted → least):**

1. **Deterministic structural/static-analysis metrics** — warning counts, import checks
2. **Deterministic lexical metrics** — ROUGE, boilerplate detection
3. **Embedding/clustering** — frozen model/version, reproducible thresholds
4. **LLM judgments** — only for semantic questions that can't be resolved mechanically

**LLM judge guardrails:**
- Use a provider **not** in the evaluated council when possible
- Blind provider identity, randomize response order
- Narrow rubric per dimension (not one holistic score)
- Persist raw judgment + model/provider + prompt version
- Track judge disagreement across duplicate runs
- Maintain a human-labeled benchmark set
- **Never use judge score as sole deployment gate**

---

## 8. Implementation Sequence

| Phase | What | LLM Required? |
|-------|------|:-:|
| 1 | Evaluation types + deterministic context metrics | ❌ |
| 2 | Structured finding parsing with explicit failures | ❌ |
| 3 | Pairwise lexical metrics + finding clustering | ❌ |
| 4 | New DB tables + persistence | ❌ |
| 5 | JSON evaluation artifact + report section | ❌ |
| 6 | Inline MCP integration without changing consultation status | ❌ |
| 7 | Optional semantic embeddings + LLM judges | ✅ |
| 8 | Calibrate against human-labeled corpus | ✅ |

> [!CAUTION]
> **Do not introduce composite scores before calibration.** Surface a multi-dimensional scorecard first. Introduce weighted composites only after correlation with human evaluation is established.

---

## Key Open Decisions

1. **Should `contextValidation.ts` be refactored to return structured warning objects?** (vs. parsing strings)
2. **Should `CouncilConsultationResult` be extended with a structured `contextEvaluation` field?** (vs. warnings-only)
3. **O(N²) avoidance:** Use ROUGE pairwise (deterministic, cheap) or single-call LLM clustering for diversity?
4. **Durable post-hoc execution:** Resolved for V1: inline only. Future post-hoc execution needs a durable worker/queue or manual MCP tool, not process-lifetime background promises.
5. **Evaluation as its own MCP tool?** (e.g., `evaluate_council_run` to re-run evaluation on past runs)
