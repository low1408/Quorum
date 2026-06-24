# Materialize Validation Tests MCP Tool

## Summary
Add a patch-only MCP tool, `materialize_validation_tests`, that converts structured Quorum findings plus repository context into executable test files returned as a unified diff. V1 will not parse Markdown reports, read previous run artifacts, write repo files, run tests, or merge multiple model candidates.

## Key Changes
- Add a new engine module, `from_orchestrator/engine/validationTests.ts`, with:
  - Input type: `{ objective, findings, context, test_framework?, target_test_dir?, style_constraints?, provider?, max_wait_ms?, provider_timeout_ms?, runnerFactory? }`.
  - Required finding shape: `{ id?, classification?, severity?, description, evidence?, validation_test }`.
  - Output type: `{ status, test_patch, tests, uncovered_findings, warnings, provider, raw_response? }`.
- Register MCP tool `materialize_validation_tests` in `from_orchestrator/mcp/server.ts`.
  - Validate with Zod.
  - Require at least one finding and at least one context file.
  - Return patch and metadata only; never apply changes to disk.
- Use single-provider synthesis.
  - Default provider: first configured council provider unless `provider` is passed.
  - Prompt the provider to return strict JSON only.
  - Require generated tests to target the supplied findings and avoid production-code edits.
- Add response validation.
  - Reject responses without a non-empty unified diff.
  - Reject patches that modify files outside test-like paths unless `target_test_dir` explicitly allows them.
  - Mark findings as uncovered instead of fabricating tests when context is insufficient.
- Keep report/run lookup out of v1.
  - Callers must pass structured findings directly.
  - Future report parsing can be added once Quorum stores normalized finding records.

## Public Interface
```ts
materialize_validation_tests({
  objective: string,
  findings: Array<{
    id?: string,
    classification?: string,
    severity?: string,
    description: string,
    evidence?: string,
    validation_test: string
  }>,
  context: {
    files: Array<{ path: string, content: string, relevance?: string }>
  },
  test_framework?: "auto" | "node:test" | "vitest" | "jest" | "pytest",
  target_test_dir?: string,
  style_constraints?: string,
  provider?: string,
  max_wait_ms?: number,
  provider_timeout_ms?: number
})
```

Return:
```ts
{
  status: "COMPLETED" | "PARTIAL" | "FAILED",
  test_patch: string,
  tests: Array<{ path: string, target_finding_id?: string, assertion_summary: string }>,
  uncovered_findings: Array<{ finding_id?: string, reason: string }>,
  warnings: string[],
  provider: string
}
```

## Test Plan
- Unit test prompt construction includes objective, findings, validation-test prose, context files, and patch-only constraints.
- Unit test strict JSON extraction accepts clean JSON and fenced JSON, and rejects prose-only or malformed output.
- Unit test response validation rejects empty patches, production-code-only patches, and missing finding mappings.
- MCP handler test verifies successful mock-provider response returns structured content and records no filesystem writes.
- MCP handler test verifies invalid inputs fail before provider execution.
- Run `npm test` and `npm run typecheck`.

## Assumptions
- V1 is optimized for structured findings, patch-only output, and single-provider synthesis.
- `test_framework: "auto"` defaults to `node:test` for this repository when `package.json` indicates Node’s built-in test runner.
- Generated tests are advisory artifacts; execution belongs to a later `verify_implementation`/runner tool.
