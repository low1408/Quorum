# Quorum LLM Council

## Overview

Quorum LLM Council is a TypeScript/Node.js MCP server that coordinates structured reviews across multiple LLM providers. It validates review context, runs council-style consultations, persists run state, and writes report artifacts for follow-up analysis.

### Problem

- Developers and reviewers who need multi-model code review or analysis are affected.
- Coordinating several LLM tools manually is inconsistent: prompts drift, context can be incomplete, review claims may lack evidence, and private files can accidentally be included.

### Outcome

- Built an MCP-compatible council orchestrator with provider adapters, structured context validation, report artifact generation, SQLite persistence, and automated tests.
- Added a review-context generator so large review requests can be packaged with evidence, omissions, privacy checks, and reproducible test/runtime context.

---

## Demo

From the user's perspective:

1. Copy `.env.example` to `.env` and configure the provider/runtime settings.
2. Start the MCP server with `npm run mcp:start`.
3. Send a `consult_council` request with a question and structured review context.
4. The server validates the request, coordinates the configured council providers, and stores run/task state.
5. The final council report is written as a Markdown artifact for review.

Demo media pending. Add screenshots, a GIF, or a short demo video here when available.

---

## Technology Stack

### Frontend components:

- No standalone frontend is currently included.
- Playwright-driven browser sessions are used where provider interaction requires browser automation.

### Backend components:

- Node.js
- TypeScript
- Model Context Protocol SDK
- better-sqlite3
- Zod
- Playwright and Playwright Extra
- dotenv

---

## Installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env` and configure provider, database, encryption, and browser settings.

---

## Usage

Start the MCP server:

```bash
npm run mcp:start
```

Run tests:

```bash
npm test
```

Run the TypeScript checker:

```bash
npm run typecheck
```

Generate a review-context bundle:

```bash
npm run review-context
```

Validate review-context generation and privacy exclusions:

```bash
npm run review-context:test
```

Expected behavior: council requests are validated, executed through configured providers, persisted to the local database, and saved as Markdown report artifacts.

---

## Project Structure

- `from_orchestrator/` - application source code for adapters, MCP server, orchestration engine, database, security, configuration, and tools.
- `tests/` - Node test suites for council behavior, debate flow, context validation, runner behavior, and report artifacts.
- `docs/` - project documentation, including the review-context guide.
- `docs/ai-dev/` - AI usage documentation for tools, prompts, review decisions, and reflection.
- `scripts/` - utility and automation scripts, including review-context generation.
- `Extra/` - sanitized AI development logs and submission extras.
- `review-context/` - generated review bundles; ignored by default because contents are reproducible and may include large evidence payloads.
- `quorum/` - raw generated council reports; ignored by default and copied into `Extra/` only after review/sanitization.
- `sessions/` - encrypted local provider session state; ignored and not suitable for submission.

