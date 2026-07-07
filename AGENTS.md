# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript/Node.js MCP server for coordinating multi-provider LLM council reviews. Main source lives in `from_orchestrator/`: provider adapters in `adapters/`, runtime configuration in `config/`, context validation in `context/`, SQLite persistence in `db/`, orchestration logic in `engine/`, MCP tools/server code in `mcp/`, security helpers in `security/`, and shared utilities in `utils/`. Tests live in `tests/*.test.ts`. Utility scripts live in `scripts/`. Documentation belongs in `docs/`; generated or sanitized artifacts are under `Extra/`. Treat `sessions/`, `quorum/`, and `review-context/` as generated/local outputs unless a task explicitly says otherwise.

## Build, Test, and Development Commands

- `npm install`: install project dependencies.
- `npm run mcp:start`: start the MCP server with Node type stripping.
- `npm test`: run Node test suites with test-safe environment variables and a temporary SQLite database.
- `npm run typecheck`: run `tsc --noEmit` in strict mode.
- `npm run review-context`: generate a review-context bundle.
- `npm run review-context:test`: validate review-context generation and privacy exclusions.

When running shell commands as an agent, prefix command segments with `rtk` where practical, for example `rtk git status` or `rtk npm test`.

## Coding Style & Naming Conventions

Use TypeScript ES modules with strict checking. Prefer explicit types at module boundaries, immutable runtime configuration, and small files grouped by domain. Follow existing naming: camelCase for variables/functions, PascalCase for types/classes, and `*.test.ts` for tests. Keep imports compatible with NodeNext resolution and the repository’s existing `.ts` import style. Do not commit local provider sessions, raw reports, databases, or generated review bundles.

## Testing Guidelines

Tests use Node’s built-in test runner via `node --test`. Add or update tests in `tests/` for behavior changes, especially around provider execution, context validation, persistence, MCP tools, and report artifacts. Keep tests hermetic: use temporary paths/databases and avoid live provider/browser dependencies in `npm test`.

## Commit & Pull Request Guidelines

Recent commits are short, verb-led summaries such as `Make runtime configuration explicit and immutable` and `Add extensible provider registry`. Use concise present-tense messages that describe the change. Pull requests should include a clear summary, relevant issue links, test results (`npm test`, `npm run typecheck`), and notes for configuration, persistence, or artifact-output changes. Include screenshots or sample reports only when user-facing output changes.
