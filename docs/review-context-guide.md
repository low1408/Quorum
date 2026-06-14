# Review Context Guide

This repository uses curated review bundles when asking an LLM to review behavior-heavy code. The goal is not to minimize tokens; it is to maximize decision-relevant evidence per token.

## Required Objective

Every review bundle must start with a concrete task. Prefer objectives such as:

> Review the `consult_council` request lifecycle for validation, concurrency limits, timeout and cancellation behavior, retry policy, resource cleanup, and persistence consistency.

Avoid broad requests such as "review this repository". Without a defined question, relevance and omission choices are arbitrary.

## Bundle Shape

Use this order:

1. Review objective and required response format.
2. Compact architecture map and execution flow.
3. Assumptions and invariants.
4. Core implementation evidence.
5. Supporting contracts and configuration.
6. Privacy and persistence evidence.
7. Tests and runtime evidence.
8. Explicit omissions and limitations.

Preserve file boundaries with clear delimiters:

```text
===== FILE: from_orchestrator/engine/council.ts =====
...
===== END FILE =====
```

Use line numbers when possible. Do not minify code or remove comments that explain invariants.

For MCP consultations, prefer a generated JSON context over hand-built payloads. The JSON context keeps raw source bodies in `context.files` and describes them with `schema_version`, `evidence_manifest`, excerpt metadata, provenance, roles, and stable evidence IDs. Structured review prose should orient the reviewers, while source files remain the authoritative evidence.

Each source item should identify:

- `id` from the evidence manifest;
- normalized `path`;
- SHA-256 of the serialized content;
- `role` such as `core`, `contract`, `config`, `test`, `runtime`, or `supporting`;
- `provenance` such as `repository`, `generated`, `test-runtime`, or `caller-supplied`;
- `relevance`;
- line range, total line count, and whether the content is an excerpt.

## Evidence Selection

Include complete implementation for decisive behavior:

- orchestration entry points;
- lifecycle and ownership logic;
- concurrency coordination;
- cancellation and timeout handling;
- error propagation and retry logic;
- resource creation and cleanup;
- persistence state transitions;
- security-sensitive validation, redaction, encryption, and storage paths.

Use contracts or focused excerpts for dependencies whose internal behavior cannot materially change the review conclusion. Omit generated, repetitive, boilerplate, or unrelated code, but state every meaningful omission explicitly.

Never replace behaviorally decisive method bodies with `/* omitted */`. A cleanup or cancellation review needs the complete path from acquisition through success, failure, timeout, cancellation, retry, and final cleanup.

## Runtime Evidence

Runtime evidence should be reproducible and sanitized. For the default council lifecycle bundle, use mock/test evidence only:

- the actual `npm test` command and output;
- representative mock `consult_council` request and response shape;
- sanitized `Runs` and `Tasks` rows from the test database;
- retry/failure evidence from the existing council tests.

Do not include live browser session state, real `.env` values, production databases, provider logs, or unredacted payloads that look secret-bearing.

## Required Reviewer Format

Ask reviewers to classify each finding as one of:

- **Confirmed defect**: demonstrated by visible code or runtime evidence.
- **Likely defect**: strongly suggested, but hidden code could alter the conclusion.
- **Architectural risk**: the design permits failure, but no failing path is established.
- **Hardening recommendation**: improvement without a demonstrated current defect.
- **Unverifiable**: insufficient context.

Each finding should include evidence, severity, confidence, and any missing context needed to strengthen or dismiss it.

Claims without exact supporting evidence must be classified as **Unverifiable**. Validation and completeness warnings are coverage limitations, not findings by themselves.

## Standard Command

Generate the default council lifecycle bundle with:

```bash
npm run review-context
```

This writes both:

- `review-context/council-lifecycle.md` for human inspection;
- `review-context/council-lifecycle.context.json` for MCP-compatible council requests.

Validate generation, required sections, and basic privacy exclusions with:

```bash
npm run review-context:test
```

Validation runs the test suite, checks the Markdown privacy exclusions, and round-trips the generated JSON through `validateCouncilContext`.

## Enforcing Structured MCP Context

Set this environment variable on the MCP server to reject raw-only `consult_council` requests:

```bash
REQUIRE_STRUCTURED_REVIEW_CONTEXT=true
```

When enabled, callers must include `context.structured_review` with these non-empty fields:

- `review_objective`
- `architecture`
- `execution_flow`
- `assumptions_and_invariants`
- `core_evidence`
- `supporting_contracts`
- `privacy_and_persistence`
- `tests_and_runtime_evidence`
- `omitted_material`

The ordinary `context.files` array is still required so the council receives source evidence with file boundaries. The structured fields force callers to provide orientation, evidence grouping, runtime/test evidence, and explicit omissions instead of sending an unframed raw code dump.

Direct MCP callers may also include:

- `schema_version`;
- `evidence_manifest`;
- file-level `start_line`, `end_line`, `total_lines`, and `is_excerpt`.

The MCP schema rejects unknown fields. The validator also rejects sensitive paths such as real `.env` files, session state, local databases, logs, `.git` internals, private keys, and saved council reports. `.env.example` is allowed when sanitized.
