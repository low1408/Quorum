import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'review-context');
const outputPath = path.join(outputDir, 'council-lifecycle.md');
const testDbPath = '/tmp/quorum-council-test.db';

const validateOnly = process.argv.includes('--validate');

const requiredSections = [
  '# Review Objective',
  '# Architecture',
  '# Assumptions and Invariants',
  '# Core Implementation Evidence',
  '# Supporting Contracts and Configuration',
  '# Privacy and Persistence Evidence',
  '# Tests and Runtime Evidence',
  '# Omitted Material and Limitations'
];

const fullImplementationFiles = [
  'from_orchestrator/mcp/server.ts',
  'from_orchestrator/engine/council.ts',
  'from_orchestrator/engine/runner.ts',
  'from_orchestrator/engine/providerSessionPool.ts',
  'from_orchestrator/engine/failures.ts',
  'from_orchestrator/engine/statuses.ts',
  'from_orchestrator/mcp/contextValidation.ts',
  'from_orchestrator/security/encryption.ts',
  'from_orchestrator/security/sessionManager.ts'
];

const supportingFiles = [
  'from_orchestrator/adapters/base.ts',
  'from_orchestrator/adapters/registry.ts',
  'from_orchestrator/adapters/mock.ts',
  'from_orchestrator/config/index.ts',
  '.env.example'
];

const testFiles = [
  'tests/council.test.ts',
  'tests/runner.test.ts',
  'tests/contextValidation.test.ts'
];

function relPath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replaceAll(path.sep, '/');
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function sanitizeText(value: string): string {
  return value
    .replaceAll('default_fallback_secret_key_32_chars_long', '[REDACTED_DEFAULT_ENCRYPTION_KEY]')
    .replace(/(ENCRYPTION_KEY=)[^\s"']+/g, '$1[REDACTED]')
    .replace(/(API_KEY=)[A-Za-z0-9_\-]{12,}/g, '$1[REDACTED]')
    .replace(/(TOKEN=)[A-Za-z0-9_\-./]{12,}/g, '$1[REDACTED]')
    .replace(/(PASSWORD=)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-[REDACTED]');
}

function withLineNumbers(content: string, startLine = 1): string {
  const lines = sanitizeText(content).replace(/\s+$/u, '').split(/\r?\n/u);
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

function fileBlock(relativePath: string, content: string, startLine = 1): string {
  const label = startLine === 1 ? relativePath : `${relativePath}:${startLine}`;
  return [
    `===== FILE: ${label} =====`,
    '```ts',
    withLineNumbers(content, startLine),
    '```',
    '===== END FILE ====='
  ].join('\n');
}

function fullFileBlock(relativePath: string): string {
  return fileBlock(relativePath, readRepoFile(relativePath));
}

function findLineIndex(lines: string[], pattern: RegExp, startAt = 0): number {
  for (let index = startAt; index < lines.length; index++) {
    if (pattern.test(lines[index])) return index;
  }
  return -1;
}

function excerptByPatterns(relativePath: string, ranges: Array<{ title: string; start: RegExp; end: RegExp }>): string {
  const content = readRepoFile(relativePath);
  const lines = content.split(/\r?\n/u);
  const blocks: string[] = [];

  for (const range of ranges) {
    const start = findLineIndex(lines, range.start);
    if (start === -1) {
      blocks.push(`===== EXCERPT MISSING: ${relativePath} (${range.title}) =====`);
      continue;
    }

    const end = findLineIndex(lines, range.end, start + 1);
    const endExclusive = end === -1 ? Math.min(lines.length, start + 120) : end;
    const excerpt = lines.slice(start, endExclusive).join('\n');
    blocks.push(`## ${range.title}\n\n${fileBlock(relativePath, excerpt, start + 1)}`);
  }

  return blocks.join('\n\n');
}

function runTests(): { command: string; output: string; status: number | null } {
  const result = spawnSync('npm', ['test'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_PATH: testDbPath
    }
  });

  return {
    command: 'npm test',
    output: sanitizeText(`${result.stdout || ''}${result.stderr || ''}`).trim(),
    status: result.status
  };
}

function safeJson(value: unknown): string {
  return sanitizeText(JSON.stringify(value, null, 2));
}

function queryRuntimeRows(): string {
  if (!fs.existsSync(testDbPath)) {
    return `Test database not found at ${testDbPath}.`;
  }

  const db = new Database(testDbPath);
  try {
    const runs = db.prepare(`
      SELECT run_id, topic, status, created_at, updated_at
      FROM Runs
      ORDER BY created_at DESC
      LIMIT 5
    `).all();

    const tasks = db.prepare(`
      SELECT task_id, run_id, provider_name, status, attempt_no, failure_code, submission_confirmed, extraction_method
      FROM Tasks
      ORDER BY created_at DESC
      LIMIT 12
    `).all();

    const retryRows = db.prepare(`
      SELECT task_id, attempt_no, status, failure_code, submission_confirmed
      FROM Tasks
      WHERE task_id LIKE '%_mock_attempt_%'
      ORDER BY created_at DESC, attempt_no ASC
      LIMIT 12
    `).all();

    return [
      '## Sanitized Runs',
      '```json',
      safeJson(runs),
      '```',
      '',
      '## Sanitized Tasks',
      '```json',
      safeJson(tasks),
      '```',
      '',
      '## Retry/Failure Rows',
      '```json',
      safeJson(retryRows),
      '```'
    ].join('\n');
  } finally {
    db.close();
  }
}

function representativeRequest(): string {
  return [
    '```json',
    safeJson({
      question: 'Review this function and suggest implementation options.',
      context: {
        files: [
          {
            path: 'virtual.ts',
            content: 'export function add(a: number, b: number) { return a + b; }'
          }
        ],
        notes: 'A small virtual file for mock integration.'
      },
      providers: ['mock'],
      max_wait_ms: 30000,
      max_retries: 1
    }),
    '```'
  ].join('\n');
}

function buildBundle(): { markdown: string; testStatus: number | null } {
  const testRun = runTests();
  const blocks: string[] = [];

  blocks.push(`# Review Objective

Review the \`consult_council\` request lifecycle for validation, concurrency limits, timeout and cancellation behavior, retry policy, resource cleanup, privacy controls, and persistence consistency.

Required reviewer response format:

- Finding classification: Confirmed defect, Likely defect, Architectural risk, Hardening recommendation, or Unverifiable.
- Evidence: cite visible file names, line numbers, runtime rows, or test output.
- Severity: Critical, High, Medium, Low, or Informational.
- Confidence: High, Medium, or Low.
- Missing context: state exact symbols or runtime traces needed if confidence is limited.`);

  blocks.push(`# Architecture

Directory structure:

\`\`\`text
from_orchestrator/
  adapters/   provider browser contracts and implementations
  config/     environment parsing and default resolution
  db/         SQLite schema, repair, and persistence service
  engine/     council orchestration, runner lifecycle, retries, status helpers
  mcp/        MCP server entry point and context validation
  security/   session encryption, storage, and input simulation
  tools/      prompt splitting utilities
tests/        node:test coverage for validation, council behavior, and runner lifecycle
\`\`\`

Execution flow:

\`\`\`text
consult_council
  -> initSchema
  -> validateCouncilContext
  -> runCouncilConsultation
  -> ProviderSessionPool.acquire
  -> OrchestrationRunner.executeTask
  -> BrowserAdapter dispatch/extract lifecycle
  -> DBService run/task status updates
  -> consolidation task
  -> structured MCP response
\`\`\``);

  blocks.push(`# Assumptions and Invariants

- Generated evidence is local and mock/test based; it does not exercise live provider websites.
- \`SessionPoolItem\` ownership flags decide whether pages, contexts, and browsers are closed.
- Terminal statuses should not be overwritten by later persistence writes.
- Provider retries are allowed only for classified retryable failures where submission was not confirmed.
- Context validation rejects likely binary files, path traversal, missing hashes, stale content, and secret-bearing payloads.
- Review bundles redact secret-looking values and never include live session files, real environment files, production DB files, or browser state.`);

  blocks.push(`# Core Implementation Evidence

${fullImplementationFiles.map(fullFileBlock).join('\n\n')}`);

  blocks.push(`# Supporting Contracts and Configuration

${supportingFiles.map(fullFileBlock).join('\n\n')}

## Database Schema and State Transitions

${excerptByPatterns('from_orchestrator/db/database.ts', [
  {
    title: 'Schema initialization and table definitions',
    start: /^export function initSchema\(\)/,
    end: /^export class DBService/
  },
  {
    title: 'Run and task persistence methods',
    start: /^\s+public static createRun\(/,
    end: /^\s+\/\*\*\n\s+\* Creates a workflow run/
  },
  {
    title: 'Workflow attempt persistence methods',
    start: /^\s+public static createTaskAttempt\(/,
    end: /^\s+\/\*\*\n\s+\* Creates an artifact/
  },
  {
    title: 'Human review and reset state transitions',
    start: /^\s+public static setInvocationAwaitingReview\(/,
    end: /^\s+public static getRecentRuns/
  }
])}`);

  blocks.push(`# Privacy and Persistence Evidence

The decisive privacy and persistence implementation is included above in:

- \`from_orchestrator/mcp/contextValidation.ts\` for secret-pattern rejection and context validation.
- \`from_orchestrator/security/encryption.ts\` and \`from_orchestrator/security/sessionManager.ts\` for session encryption and storage.
- \`from_orchestrator/db/database.ts\` excerpts for schema creation and terminal-status-aware updates.
- \`.env.example\` for redacted behaviorally relevant configuration.

Generated bundles must not include \`sessions/\`, real \`.env\`, \`orchestrator.db\`, logs, or browser storage state.`);

  blocks.push(`# Tests and Runtime Evidence

## Representative consult_council Request

${representativeRequest()}

## Test Command

\`\`\`text
${testRun.command}
exit_status=${testRun.status}
\`\`\`

## Test Output

\`\`\`text
${testRun.output}
\`\`\`

${testFiles.map(fullFileBlock).join('\n\n')}

${queryRuntimeRows()}`);

  blocks.push(`# Omitted Material and Limitations

Omitted:

- Most concrete provider adapter bodies beyond the base contract, registry, and mock adapter. They are repetitive browser-specialization details unless a provider-specific lifecycle review is requested.
- Workflow compiler, DAG runner, debate, summarization, and evaluation modules. They do not participate in the default \`consult_council\` MCP lifecycle path under review.
- \`node_modules/\`, lockfile contents, local database files, session storage, logs, and real environment files. They are generated, third-party, or private runtime artifacts.
- Live provider traces. This bundle intentionally uses reproducible mock/test evidence only.

Potential limitations:

- Browser-provider-specific completion detection, authentication, and page anomaly behavior are only represented by shared contracts and common runner paths.
- Runtime evidence proves the tested mock paths and retry scenarios, not live provider website behavior.`);

  return {
    markdown: blocks.join('\n\n'),
    testStatus: testRun.status
  };
}

function validateBundle(markdown: string, testStatus: number | null): void {
  const missing = requiredSections.filter(section => !markdown.includes(section));
  if (missing.length > 0) {
    throw new Error(`Generated review context is missing required sections: ${missing.join(', ')}`);
  }

  const forbiddenFileDelimiters = [
    '===== FILE: sessions/',
    '===== FILE: .env =====',
    '===== FILE: orchestrator.db',
    '===== FILE: node_modules/'
  ];
  const presentForbidden = forbiddenFileDelimiters.filter(value => markdown.includes(value));
  if (presentForbidden.length > 0) {
    throw new Error(`Generated review context includes forbidden private/generated files: ${presentForbidden.join(', ')}`);
  }

  if (/ENCRYPTION_KEY=(?!\[REDACTED\]|replace_with_32_plus_character_secret)/.test(markdown)) {
    throw new Error('Generated review context appears to include an unredacted ENCRYPTION_KEY assignment.');
  }

  if (/API_KEY=[A-Za-z0-9_\-]{12,}/.test(markdown)) {
    throw new Error('Generated review context appears to include an unredacted API_KEY assignment.');
  }

  if (testStatus !== 0) {
    throw new Error(`Runtime evidence command failed with exit status ${testStatus}.`);
  }
}

function main(): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const { markdown, testStatus } = buildBundle();
  fs.writeFileSync(outputPath, markdown, 'utf8');

  if (validateOnly) {
    validateBundle(markdown, testStatus);
    console.log(`Generated and validated ${relPath(outputPath)}`);
  } else {
    console.log(`Generated ${relPath(outputPath)}`);
  }
}

main();
