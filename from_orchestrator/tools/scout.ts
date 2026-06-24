import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.ts';
import {
  assertSafeContextPath,
  candidateImportPaths,
  normalizeContextPath,
  referencedRepositoryPaths,
  resolveLikelyImportPath,
  validateCouncilContext,
  validateCouncilRequestText,
  type CouncilContext,
  type CouncilEvidenceRole
} from '../mcp/contextValidation.ts';

type ScoutRole = Extract<CouncilEvidenceRole, 'core' | 'contract' | 'config' | 'test' | 'supporting'>;

export type ScoutDiscoverContextArgs = {
  query: string;
  repo_root?: string;
  entrypoints?: string[];
  changed_files?: string[];
  token_budget_chars?: number;
  max_dependency_depth?: number;
  include_tests?: boolean;
  include_reverse_importers?: boolean;
};

export type ScoutRecommendedFile = {
  path: string;
  role: ScoutRole;
  relevance_score: number;
  relevance_reason: string;
  is_core: boolean;
  source: string;
  size_chars: number;
};

export type ScoutOmittedFile = {
  path: string;
  reason: string;
  size_chars?: number;
};

export type ScoutDiscoverContextResult = {
  context: CouncilContext;
  context_digest: string;
  recommended_files: ScoutRecommendedFile[];
  omitted_files: ScoutOmittedFile[];
  warnings: string[];
  stats: {
    strategy: 'deterministic-v1';
    candidate_count: number;
    selected_count: number;
    total_chars: number;
    token_budget_chars: number;
  };
};

type RepoFile = {
  path: string;
  content: string;
  sizeChars: number;
};

type Candidate = {
  path: string;
  role: ScoutRole;
  score: number;
  isCore: boolean;
  source: string;
  reasons: string[];
};

const DEFAULT_TOKEN_BUDGET_CHARS = 300_000;
const MAX_TOKEN_BUDGET_CHARS = 700_000;
const MAX_CONTEXT_FILE_CHARS = 250_000;
const DEFAULT_DEPENDENCY_DEPTH = 2;
const MAX_DEPENDENCY_DEPTH = 5;
const LEXICAL_CANDIDATE_LIMIT = 8;
const SCHEMA_VERSION = '2026-06-14';

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'are',
  'before',
  'build',
  'can',
  'code',
  'could',
  'debug',
  'file',
  'files',
  'fix',
  'for',
  'from',
  'how',
  'implement',
  'implementation',
  'into',
  'please',
  'repo',
  'repository',
  'should',
  'that',
  'the',
  'this',
  'tool',
  'tools',
  'typescript',
  'use',
  'used',
  'using',
  'what',
  'when',
  'where',
  'with',
  'would'
]);

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/u).length;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) {
    throw new Error('Scout numeric options must be integers.');
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function assertWorkspaceRoot(repoRoot?: string): void {
  if (!repoRoot) return;
  const requestedRoot = path.resolve(repoRoot);
  const configuredRoot = path.resolve(config.rootDir);
  if (requestedRoot !== configuredRoot) {
    throw new Error(`Scout repo_root must match configured workspace root: ${configuredRoot}`);
  }
}

function isExcludedPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const parts = lower.split('/');
  const basename = path.posix.basename(lower);
  const safeEnvExamples = new Set(['.env.example', 'env.example']);
  const excludedDirectories = new Set([
    '.cache',
    '.agents',
    '.codex',
    '.git',
    '.vscode',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'quorum',
    'review-context',
    'sessions'
  ]);

  if (parts.some(part => excludedDirectories.has(part))) return true;
  if (lower.startsWith('extra/ai-chat-logs/')) return true;
  if (basename === 'package-lock.json') return true;
  if ((basename === '.env' || basename.startsWith('.env.')) && !safeEnvExamples.has(basename)) return true;
  if (
    lower.endsWith('.log') ||
    lower.endsWith('.db') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.includes('private_key')
  ) {
    return true;
  }

  return false;
}

function isLikelyTextPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath.toLowerCase());
  if (basename === '.env.example' || basename === 'env.example') return true;
  return /\.(?:cjs|cts|d\.ts|js|json|jsx|md|mjs|mts|ts|tsx|txt|yaml|yml)$/.test(relativePath);
}

function scanRepository(rootDir: string): Map<string, RepoFile> {
  const files = new Map<string, RepoFile>();

  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (isExcludedPath(relativePath)) continue;

      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !isLikelyTextPath(relativePath)) continue;

      const normalizedPath = relativePath.replace(/\\/g, '/');
      try {
        assertSafeContextPath(normalizedPath);
        const content = fs.readFileSync(absolutePath, 'utf8');
        if (content.trim() === '') continue;
        files.set(normalizedPath, {
          path: normalizedPath,
          content,
          sizeChars: content.length
        });
      } catch {
        continue;
      }
    }
  };

  visit(rootDir, '');
  return files;
}

function normalizeQueryTerms(query: string): string[] {
  const expanded = query.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const terms = expanded
    .split(/[^a-z0-9]+/u)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term));
  return Array.from(new Set(terms)).slice(0, 40);
}

function classifyRole(relativePath: string, fallback: ScoutRole = 'supporting'): ScoutRole {
  const basename = path.posix.basename(relativePath);
  if (relativePath === 'package.json' || relativePath === 'tsconfig.json' || /\.ya?ml$/.test(relativePath)) return 'config';
  if (relativePath.startsWith('tests/') || /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(basename)) return 'test';
  return fallback;
}

function rolePriority(role: ScoutRole): number {
  switch (role) {
    case 'core':
      return 0;
    case 'contract':
      return 1;
    case 'config':
      return 2;
    case 'test':
      return 3;
    case 'supporting':
      return 4;
  }
}

function outputSort(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const roleDelta = rolePriority(a.role) - rolePriority(b.role);
  if (roleDelta !== 0) return roleDelta;
  return a.path.localeCompare(b.path);
}

function budgetSort(a: Candidate, b: Candidate): number {
  if (a.isCore !== b.isCore) return a.isCore ? -1 : 1;
  return outputSort(a, b);
}

function dedupeWarnings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function addOmission(omissions: Map<string, ScoutOmittedFile>, omitted: ScoutOmittedFile): void {
  if (!omissions.has(omitted.path)) {
    omissions.set(omitted.path, omitted);
  }
}

function resolveInputPathCandidates(rawPath: string, repoFiles: Map<string, RepoFile>): string[] {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeContextPath(rawPath);
    assertSafeContextPath(normalizedPath);
  } catch {
    return [];
  }

  if (repoFiles.has(normalizedPath)) return [normalizedPath];

  const lower = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lower);
  const matches = Array.from(repoFiles.keys()).filter(candidatePath => {
    const candidateLower = candidatePath.toLowerCase();
    return (
      candidateLower === lower ||
      candidateLower.endsWith(`/${lower}`) ||
      path.posix.basename(candidateLower) === basename
    );
  });

  return Array.from(new Set(matches)).sort();
}

function addCandidate(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
  rawPath: string;
  score: number;
  role: ScoutRole;
  source: string;
  reason: string;
  isCore: boolean;
}): void {
  let normalizedForOmission = params.rawPath;
  try {
    normalizedForOmission = normalizeContextPath(params.rawPath);
    assertSafeContextPath(normalizedForOmission);
  } catch (err) {
    params.warnings.push(`Scout skipped unsafe path ${params.rawPath}: ${err instanceof Error ? err.message : String(err)}`);
    addOmission(params.omissions, { path: params.rawPath, reason: 'unsafe path' });
    return;
  }

  const paths = resolveInputPathCandidates(params.rawPath, params.repoFiles);
  if (paths.length === 0) {
    params.warnings.push(`Scout could not find referenced file: ${params.rawPath}`);
    addOmission(params.omissions, { path: normalizedForOmission, reason: 'not found or excluded' });
    return;
  }

  for (const candidatePath of paths) {
    const previous = params.candidates.get(candidatePath);
    const role = classifyRole(candidatePath, params.role);
    if (!previous) {
      params.candidates.set(candidatePath, {
        path: candidatePath,
        role,
        score: params.score,
        isCore: params.isCore,
        source: params.source,
        reasons: [params.reason]
      });
      continue;
    }

    if (!previous.reasons.includes(params.reason)) {
      previous.reasons.push(params.reason);
    }
    previous.isCore = previous.isCore || params.isCore;
    if (params.score > previous.score) {
      previous.score = params.score;
      previous.role = role;
      previous.source = params.source;
    }
  }
}

function resolveLocalImports(relativePath: string, repoFiles: Map<string, RepoFile>): string[] {
  const file = repoFiles.get(relativePath);
  if (!file) return [];

  const imports = new Set<string>();
  for (const importPath of candidateImportPaths(file.content)) {
    for (const candidate of resolveLikelyImportPath(relativePath, importPath)) {
      if (repoFiles.has(candidate)) {
        imports.add(candidate);
        break;
      }
    }
  }

  return Array.from(imports).sort();
}

function buildReverseImportIndex(repoFiles: Map<string, RepoFile>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const relativePath of repoFiles.keys()) {
    for (const importedPath of resolveLocalImports(relativePath, repoFiles)) {
      const importers = reverse.get(importedPath) || [];
      importers.push(relativePath);
      reverse.set(importedPath, importers);
    }
  }
  for (const importers of reverse.values()) {
    importers.sort();
  }
  return reverse;
}

function addLexicalCandidates(params: {
  query: string;
  repoFiles: Map<string, RepoFile>;
  candidates: Map<string, Candidate>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const terms = normalizeQueryTerms(params.query);
  if (terms.length === 0) return;

  const hits: Array<{ path: string; strength: number; matchedTerms: string[] }> = [];
  for (const file of params.repoFiles.values()) {
    const pathLower = file.path.toLowerCase();
    const contentLower = file.content.toLowerCase();
    const pathTerms = terms.filter(term => pathLower.includes(term));
    const contentTerms = terms.filter(term => contentLower.includes(term));
    if (pathTerms.length === 0 && contentTerms.length < 2) continue;

    hits.push({
      path: file.path,
      strength: pathTerms.length * 4 + contentTerms.length,
      matchedTerms: Array.from(new Set([...pathTerms, ...contentTerms])).slice(0, 6)
    });
  }

  hits
    .sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path))
    .slice(0, LEXICAL_CANDIDATE_LIMIT)
    .forEach(hit => {
      const pathLower = hit.path.toLowerCase();
      const hasSpecificPathHit = hit.matchedTerms.some(term => term.length >= 5 && pathLower.includes(term));
      const isSourcePath = hit.path.startsWith('from_orchestrator/') || hit.path.startsWith('scripts/');
      const role = hasSpecificPathHit && isSourcePath ? 'core' : classifyRole(hit.path, 'supporting');
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: hit.path,
        score: 0.8,
        role,
        source: 'lexical_match',
        reason: `Lexical match for query terms: ${hit.matchedTerms.join(', ')}`,
        isCore: role === 'core'
      });
    });
}

function addForwardImports(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
  maxDepth: number;
}): void {
  if (params.maxDepth <= 0) return;

  const queue: Array<{ path: string; depth: number }> = Array.from(params.candidates.values())
    .filter(candidate => candidate.isCore)
    .map(candidate => ({ path: candidate.path, depth: 0 }));
  const visited = new Map(queue.map(item => [item.path, item.depth]));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= params.maxDepth) continue;

    for (const importedPath of resolveLocalImports(current.path, params.repoFiles)) {
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: importedPath,
        score: 0.65,
        role: 'contract',
        source: 'forward_import',
        reason: `Imported by ${current.path}`,
        isCore: false
      });

      if (!visited.has(importedPath) || visited.get(importedPath)! > current.depth + 1) {
        visited.set(importedPath, current.depth + 1);
        queue.push({ path: importedPath, depth: current.depth + 1 });
      }
    }
  }
}

function addReverseImporters(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const reverseIndex = buildReverseImportIndex(params.repoFiles);
  const targetPaths = Array.from(params.candidates.keys());

  for (const targetPath of targetPaths) {
    for (const importerPath of reverseIndex.get(targetPath) || []) {
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: importerPath,
        score: 0.5,
        role: 'supporting',
        source: 'reverse_importer',
        reason: `Imports selected file ${targetPath}`,
        isCore: false
      });
    }
  }
}

function addNearbyTests(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const coreCandidates = Array.from(params.candidates.values()).filter(candidate => candidate.isCore);
  const testFiles = Array.from(params.repoFiles.values()).filter(file => classifyRole(file.path) === 'test');

  for (const candidate of coreCandidates) {
    const stem = path.posix.basename(candidate.path).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|json|md)$/u, '').toLowerCase();
    if (stem.length < 4) continue;

    for (const testFile of testFiles) {
      const testPath = testFile.path.toLowerCase();
      const testContent = testFile.content.toLowerCase();
      if (!testPath.includes(stem) && !testContent.includes(stem)) continue;
      addCandidate({
        candidates: params.candidates,
        repoFiles: params.repoFiles,
        omissions: params.omissions,
        warnings: params.warnings,
        rawPath: testFile.path,
        score: 0.5,
        role: 'test',
        source: 'nearby_test',
        reason: `Nearby test coverage for ${candidate.path}`,
        isCore: false
      });
    }
  }
}

function addConfigFiles(params: {
  query: string;
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  omissions: Map<string, ScoutOmittedFile>;
  warnings: string[];
}): void {
  const codeChangeIntent = /\b(implement|fix|debug|refactor|test|typecheck|compile|build|mcp|server)\b/i.test(params.query);
  const hasTsOrJs = Array.from(params.candidates.keys()).some(candidatePath => /\.(?:ts|tsx|js|jsx)$/.test(candidatePath));
  if (!codeChangeIntent || !hasTsOrJs) return;

  for (const configPath of ['package.json', 'tsconfig.json']) {
    addCandidate({
      candidates: params.candidates,
      repoFiles: params.repoFiles,
      omissions: params.omissions,
      warnings: params.warnings,
      rawPath: configPath,
      score: 0.5,
      role: 'config',
      source: 'config_heuristic',
      reason: 'Configuration context for TypeScript/code-change query',
      isCore: false
    });
  }
}

function selectWithinBudget(params: {
  candidates: Map<string, Candidate>;
  repoFiles: Map<string, RepoFile>;
  tokenBudgetChars: number;
  baseOmissions: Map<string, ScoutOmittedFile>;
}): {
  selected: Candidate[];
  omitted: Map<string, ScoutOmittedFile>;
  totalChars: number;
} {
  const omitted = new Map(params.baseOmissions);
  const selected: Candidate[] = [];
  let totalChars = 0;

  for (const candidate of Array.from(params.candidates.values()).sort(budgetSort)) {
    const file = params.repoFiles.get(candidate.path);
    if (!file) continue;
    if (file.sizeChars > MAX_CONTEXT_FILE_CHARS) {
      addOmission(omitted, {
        path: candidate.path,
        reason: `exceeds per-file limit of ${MAX_CONTEXT_FILE_CHARS} characters`,
        size_chars: file.sizeChars
      });
      continue;
    }
    if (totalChars + file.sizeChars > params.tokenBudgetChars) {
      addOmission(omitted, {
        path: candidate.path,
        reason: `exceeds token_budget_chars ${params.tokenBudgetChars}`,
        size_chars: file.sizeChars
      });
      continue;
    }

    selected.push(candidate);
    totalChars += file.sizeChars;
  }

  if (selected.length === 0) {
    throw new Error('Scout could not select any files within the requested token budget.');
  }

  return { selected, omitted, totalChars };
}

function selectedForOutput(selected: Candidate[], repoFiles: Map<string, RepoFile>): ScoutRecommendedFile[] {
  return selected.sort(outputSort).map(candidate => ({
    path: candidate.path,
    role: candidate.role,
    relevance_score: candidate.score,
    relevance_reason: candidate.reasons.join('; '),
    is_core: candidate.isCore,
    source: candidate.source,
    size_chars: repoFiles.get(candidate.path)?.sizeChars ?? 0
  }));
}

function formatPathList(paths: string[], emptyMessage: string): string {
  if (paths.length === 0) return emptyMessage;
  const listed = paths.slice(0, 30).join(', ');
  return paths.length > 30 ? `${listed}, and ${paths.length - 30} more.` : listed;
}

function buildStructuredReview(params: {
  query: string;
  recommended: ScoutRecommendedFile[];
  omitted: ScoutOmittedFile[];
  totalChars: number;
  tokenBudgetChars: number;
}): CouncilContext['structured_review'] {
  const corePaths = params.recommended.filter(file => file.role === 'core' || file.is_core).map(file => file.path);
  const supportPaths = params.recommended
    .filter(file => file.role === 'contract' || file.role === 'config' || file.role === 'supporting')
    .map(file => file.path);
  const testPaths = params.recommended.filter(file => file.role === 'test').map(file => file.path);
  const omitted = params.omitted
    .slice(0, 40)
    .map(file => `${file.path} (${file.reason})`);

  return {
    review_objective: `Review repository context relevant to: ${params.query}`,
    architecture: 'Scout selected files deterministically from explicit references, lexical matches, local imports, reverse importers, nearby tests, and configuration heuristics.',
    execution_flow: 'scout_discover_context scans local text files, ranks candidates, expands dependencies, prunes to budget, constructs a CouncilContext, and validates it with validateCouncilContext.',
    assumptions_and_invariants: 'V1 is deterministic and local-only; it does not use embeddings, persistent indexes, API calls, or LLM reranking. Source files and evidence_manifest entries are authoritative.',
    core_evidence: formatPathList(corePaths, 'No core files selected.'),
    supporting_contracts: formatPathList(supportPaths, 'No supporting contracts selected.'),
    privacy_and_persistence: 'Scout excludes sensitive and generated paths including real env files, session storage, logs, databases, saved council reports, node_modules, and .git internals.',
    tests_and_runtime_evidence: formatPathList(testPaths, 'No nearby tests or runtime evidence selected.'),
    omitted_material: omitted.length > 0
      ? `${omitted.join(', ')}${params.omitted.length > omitted.length ? `, and ${params.omitted.length - omitted.length} more omitted files.` : ''}`
      : `No candidate files omitted. Selected ${params.totalChars} characters within budget ${params.tokenBudgetChars}.`
  };
}

function buildCouncilContext(params: {
  query: string;
  selected: Candidate[];
  omitted: ScoutOmittedFile[];
  repoFiles: Map<string, RepoFile>;
  totalChars: number;
  tokenBudgetChars: number;
}): CouncilContext {
  const recommended = selectedForOutput([...params.selected], params.repoFiles);
  const files = recommended.map(file => {
    const repoFile = params.repoFiles.get(file.path)!;
    const lines = lineCount(repoFile.content);
    return {
      path: file.path,
      content: repoFile.content,
      sha256: sha256(repoFile.content),
      relevance: file.relevance_reason,
      start_line: 1,
      end_line: lines,
      total_lines: lines,
      is_excerpt: false
    };
  });

  return {
    schema_version: SCHEMA_VERSION,
    notes: 'Generated by scout_discover_context deterministic-v1. The context was assembled locally and validated before return.',
    files,
    evidence_manifest: recommended.map((file, index) => ({
      id: `EV${String(index + 1).padStart(3, '0')}`,
      path: file.path,
      sha256: files[index].sha256,
      role: file.role,
      provenance: 'repository',
      relevance: file.relevance_reason,
      order: index + 1,
      start_line: files[index].start_line,
      end_line: files[index].end_line,
      total_lines: files[index].total_lines,
      is_excerpt: files[index].is_excerpt
    })),
    structured_review: buildStructuredReview({
      query: params.query,
      recommended,
      omitted: params.omitted,
      totalChars: params.totalChars,
      tokenBudgetChars: params.tokenBudgetChars
    })
  };
}

function repairPathsFromWarnings(warnings: string[], selectedPaths: Set<string>, repoFiles: Map<string, RepoFile>): string[] {
  const repairPaths = new Set<string>();
  for (const warning of warnings) {
    if (!/omitted local imports|package\.json|tsconfig\.json|Question references/u.test(warning)) continue;
    for (const referencedPath of referencedRepositoryPaths(warning)) {
      const resolved = resolveInputPathCandidates(referencedPath, repoFiles);
      for (const pathCandidate of resolved) {
        if (!selectedPaths.has(pathCandidate)) {
          repairPaths.add(pathCandidate);
        }
      }
    }
  }
  return Array.from(repairPaths).sort();
}

export function discoverScoutContext(args: ScoutDiscoverContextArgs): ScoutDiscoverContextResult {
  const query = args.query;
  validateCouncilRequestText(query);
  assertWorkspaceRoot(args.repo_root);

  const tokenBudgetChars = clampInteger(
    args.token_budget_chars,
    DEFAULT_TOKEN_BUDGET_CHARS,
    1,
    MAX_TOKEN_BUDGET_CHARS
  );
  const maxDepth = clampInteger(
    args.max_dependency_depth,
    DEFAULT_DEPENDENCY_DEPTH,
    0,
    MAX_DEPENDENCY_DEPTH
  );
  const includeTests = args.include_tests !== false;
  const includeReverseImporters = args.include_reverse_importers !== false;

  const repoFiles = scanRepository(config.rootDir);
  const candidates = new Map<string, Candidate>();
  const baseOmissions = new Map<string, ScoutOmittedFile>();
  const warnings: string[] = [];

  for (const referencedPath of referencedRepositoryPaths(query)) {
    addCandidate({
      candidates,
      repoFiles,
      omissions: baseOmissions,
      warnings,
      rawPath: referencedPath,
      score: 1,
      role: 'core',
      source: 'query_path',
      reason: `Explicitly referenced by query: ${referencedPath}`,
      isCore: true
    });
  }

  for (const entrypoint of args.entrypoints || []) {
    addCandidate({
      candidates,
      repoFiles,
      omissions: baseOmissions,
      warnings,
      rawPath: entrypoint,
      score: 1,
      role: 'core',
      source: 'entrypoint',
      reason: `Provided entrypoint: ${entrypoint}`,
      isCore: true
    });
  }

  for (const changedFile of args.changed_files || []) {
    addCandidate({
      candidates,
      repoFiles,
      omissions: baseOmissions,
      warnings,
      rawPath: changedFile,
      score: 0.95,
      role: 'core',
      source: 'changed_file',
      reason: `Provided changed file: ${changedFile}`,
      isCore: true
    });
  }

  addLexicalCandidates({ query, repoFiles, candidates, omissions: baseOmissions, warnings });

  if (candidates.size === 0) {
    throw new Error('Scout could not identify any candidate files for the query.');
  }

  addForwardImports({ candidates, repoFiles, omissions: baseOmissions, warnings, maxDepth });
  if (includeReverseImporters) {
    addReverseImporters({ candidates, repoFiles, omissions: baseOmissions, warnings });
  }
  if (includeTests) {
    addNearbyTests({ candidates, repoFiles, omissions: baseOmissions, warnings });
  }
  addConfigFiles({ query, candidates, repoFiles, omissions: baseOmissions, warnings });

  let selection = selectWithinBudget({ candidates, repoFiles, tokenBudgetChars, baseOmissions });
  let context = buildCouncilContext({
    query,
    selected: selection.selected,
    omitted: Array.from(selection.omitted.values()),
    repoFiles,
    totalChars: selection.totalChars,
    tokenBudgetChars
  });
  let validated = validateCouncilContext(context, query);

  const repairPaths = repairPathsFromWarnings(
    validated.warnings,
    new Set(selection.selected.map(candidate => candidate.path)),
    repoFiles
  );

  if (repairPaths.length > 0) {
    for (const repairPath of repairPaths) {
      addCandidate({
        candidates,
        repoFiles,
        omissions: baseOmissions,
        warnings,
        rawPath: repairPath,
        score: 0.5,
        role: classifyRole(repairPath, 'contract'),
        source: 'validation_repair',
        reason: `Added from validateCouncilContext warning: ${repairPath}`,
        isCore: false
      });
    }

    selection = selectWithinBudget({ candidates, repoFiles, tokenBudgetChars, baseOmissions });
    context = buildCouncilContext({
      query,
      selected: selection.selected,
      omitted: Array.from(selection.omitted.values()),
      repoFiles,
      totalChars: selection.totalChars,
      tokenBudgetChars
    });
    validated = validateCouncilContext(context, query);
  }

  return {
    context,
    context_digest: validated.context_digest,
    recommended_files: selectedForOutput([...selection.selected], repoFiles),
    omitted_files: Array.from(selection.omitted.values()).sort((a, b) => a.path.localeCompare(b.path)),
    warnings: dedupeWarnings([...warnings, ...validated.warnings]),
    stats: {
      strategy: 'deterministic-v1',
      candidate_count: candidates.size,
      selected_count: selection.selected.length,
      total_chars: selection.totalChars,
      token_budget_chars: tokenBudgetChars
    }
  };
}
