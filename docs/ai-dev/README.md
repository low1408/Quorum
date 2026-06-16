# AI Development Notes

## AI Tools

- ChatGPT: council reviewer/provider for independent analysis.
- Claude: council provider for independent review.
- Meta: council provider for independent review.
- Kimi: council provider for independent review.
- Review-context generator: local script that packages source evidence, runtime notes, omissions, and validation metadata for AI review.

AI agent roles:

- Council reviewer: analyzes supplied evidence and returns findings using the required taxonomy.
- Evaluator/consolidator: compares council responses and produces a consolidated report.
- Mock provider: simulates provider behavior for tests without live AI access.
- Review-context generator: prepares structured, evidence-linked review bundles.

---

## Development Approach with AI

Key prompts used:

- Ask reviewers to classify findings as `Confirmed defect`, `Likely defect`, `Architectural risk`, `Hardening recommendation`, or `Unverifiable`.
- Require each finding to include severity, confidence, evidence, reasoning, missing context, implementation options, and validation tests.
- Ask the council to review request lifecycle behavior, including validation, concurrency limits, timeout and cancellation behavior, retry policy, resource cleanup, persistence consistency, and privacy handling.
- Ask consolidators to retain only evidence-supported claims and move unsupported claims to open questions or `Unverifiable`.

Key review points and decisions:

- Context validation: centralized validation rejects unsafe request shapes, sensitive paths, and secret-like content.
- Privacy exclusions: real `.env` files, encrypted sessions, local databases, logs, `.git` internals, private keys, and generated raw reports are excluded from review bundles by default.
- Persistence consistency: run and task state are tested through SQLite-backed lifecycle tests.
- Retry/failure behavior: domain errors, provider failures, and retry policy are covered by council and runner tests.
- Report artifacts: final council reports are written as Markdown artifacts and tested for expected behavior.

---

## Reflection

What worked:

- Structured review context produced more actionable AI feedback than raw code dumps.
- Evidence-linked prompts helped separate confirmed issues from speculation.

What failed or needed adjustment:

- Raw AI outputs can contain irrelevant reasoning, duplicated findings, or unsupported claims.
- Generated report folders can accumulate local artifacts, so submission copies must be reviewed and sanitized.
- Provider sessions are sensitive and must remain encrypted and ignored.
- Certain Model providers such as Gemini, were not adaptable for the task (takes too long)

Changes made and rationale:

- Changed AI output to be structured 
- Removed Gemini from model list


