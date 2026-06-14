import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.ts';

export type CouncilContextFile = {
  path: string;
  content: string;
  sha256?: string;
  modified_at?: string;
  relevance?: string;
};

export type CouncilContext = {
  files: CouncilContextFile[];
  notes?: string;
  structured_review?: CouncilStructuredReviewContext;
};

export type ValidatedCouncilContext = {
  files: Array<CouncilContextFile & { normalizedPath: string; computedSha256: string }>;
  notes?: string;
  structured_review?: CouncilStructuredReviewContext;
  warnings: string[];
};

export type CouncilStructuredReviewContext = {
  review_objective: string;
  architecture: string;
  execution_flow: string;
  assumptions_and_invariants: string;
  core_evidence: string;
  supporting_contracts: string;
  privacy_and_persistence: string;
  tests_and_runtime_evidence: string;
  omitted_material: string;
};

const MAX_FILE_CHARS = 250_000;
const MAX_TOTAL_CHARS = 750_000;
const STRUCTURED_REVIEW_FIELDS: Array<keyof CouncilStructuredReviewContext> = [
  'review_objective',
  'architecture',
  'execution_flow',
  'assumptions_and_invariants',
  'core_evidence',
  'supporting_contracts',
  'privacy_and_persistence',
  'tests_and_runtime_evidence',
  'omitted_material'
];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\b(?:sk|pk|rk|xox[baprs])-[-A-Za-z0-9_]{20,}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd|credential)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  /\bAWS_SECRET_ACCESS_KEY\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/i
];

function normalizeContextPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('Context file path must be a non-empty string.');
  }
  if (rawPath.includes('\0')) {
    throw new Error(`Context file path contains a NUL byte: ${rawPath}`);
  }

  if (path.isAbsolute(rawPath)) {
    const absolutePath = path.resolve(rawPath);
    if (!absolutePath.startsWith(config.rootDir + path.sep) && absolutePath !== config.rootDir) {
      throw new Error(`Context file path escapes the workspace: ${rawPath}`);
    }
    return path.relative(config.rootDir, absolutePath).replace(/\\/g, '/');
  }

  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Context file path escapes the workspace: ${rawPath}`);
  }
  return normalized;
}

function looksBinary(content: string): boolean {
  if (content.includes('\0')) return true;
  if (content.length === 0) return false;

  const sample = content.slice(0, 4096);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    const allowedControl = code === 9 || code === 10 || code === 13;
    if (code < 32 && !allowedControl) suspicious++;
  }
  return suspicious / sample.length > 0.02;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hasSecretMaterial(content: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(content));
}

function validateStructuredReviewContext(context: CouncilContext, warnings: string[]): CouncilStructuredReviewContext | undefined {
  const structured = context.structured_review;
  if (!structured) {
    if (config.requireStructuredReviewContext) {
      throw new Error('Structured review context is required when REQUIRE_STRUCTURED_REVIEW_CONTEXT=true.');
    }
    return undefined;
  }

  const missingFields = STRUCTURED_REVIEW_FIELDS.filter(field => {
    const value = structured[field];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missingFields.length > 0) {
    throw new Error(`Structured review context is missing required field(s): ${missingFields.join(', ')}.`);
  }

  for (const field of STRUCTURED_REVIEW_FIELDS) {
    const value = structured[field];
    if (value.length > MAX_FILE_CHARS) {
      throw new Error(`Structured review context field exceeds ${MAX_FILE_CHARS} characters: ${field}.`);
    }
    if (looksBinary(value)) {
      throw new Error(`Structured review context field appears to be binary: ${field}.`);
    }
    if (hasSecretMaterial(value)) {
      throw new Error(`Structured review context field appears to contain secret material: ${field}.`);
    }
  }

  if (!config.requireStructuredReviewContext) {
    warnings.push('Structured review context was provided but is not currently required by server configuration.');
  }

  return structured;
}

function candidateImportPaths(content: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith('./') || importPath.startsWith('../')) {
        candidates.add(importPath);
      }
    }
  }

  return Array.from(candidates);
}

function resolveLikelyImportPath(fromFile: string, importPath: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), importPath));
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
  return extensions.flatMap(ext => [
    `${base}${ext}`,
    `${base}/index${ext || '.ts'}`
  ]);
}

function addCompletenessWarnings(files: Array<CouncilContextFile & { normalizedPath: string }>, question: string, warnings: string[]): void {
  const included = new Set(files.map(file => file.normalizedPath));
  const localImports = new Set<string>();

  for (const file of files) {
    for (const importPath of candidateImportPaths(file.content)) {
      for (const candidate of resolveLikelyImportPath(file.normalizedPath, importPath)) {
        const absolute = path.resolve(config.rootDir, candidate);
        if (!included.has(candidate) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
          localImports.add(candidate);
          break;
        }
      }
    }
  }

  if (localImports.size > 0) {
    warnings.push(`Context may be incomplete: omitted local imports ${Array.from(localImports).slice(0, 8).join(', ')}.`);
  }

  const questionAndNotes = question.toLowerCase();
  const codeChangeIntent = /\b(implement|fix|debug|refactor|test|typecheck|compile|build|mcp|server)\b/.test(questionAndNotes);
  const hasTsOrJs = files.some(file => /\.(?:ts|tsx|js|jsx)$/.test(file.normalizedPath));
  if (codeChangeIntent && hasTsOrJs) {
    for (const configFile of ['package.json', 'tsconfig.json']) {
      if (!included.has(configFile) && fs.existsSync(path.resolve(config.rootDir, configFile))) {
        warnings.push(`Context may be incomplete: ${configFile} exists but was not included.`);
      }
    }
  }

  const referencedPaths = question.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml)/g) || [];
  for (const referencedPath of referencedPaths) {
    const normalized = normalizeContextPath(referencedPath);
    if (!included.has(normalized) && fs.existsSync(path.resolve(config.rootDir, normalized))) {
      warnings.push(`Question references ${normalized}, but that file was not included in context.`);
    }
  }
}

export function validateCouncilContext(context: CouncilContext, question = ''): ValidatedCouncilContext {
  if (!context || !Array.isArray(context.files)) {
    throw new Error('Context must include a files array.');
  }
  if (context.files.length === 0) {
    throw new Error('Context must include at least one file.');
  }

  const seen = new Set<string>();
  const warnings: string[] = [];
  const structuredReview = validateStructuredReviewContext(context, warnings);
  const files: ValidatedCouncilContext['files'] = [];
  let totalChars = structuredReview
    ? STRUCTURED_REVIEW_FIELDS.reduce((sum, field) => sum + structuredReview[field].length, 0)
    : 0;

  if (totalChars > MAX_TOTAL_CHARS) {
    throw new Error(`Context exceeds ${MAX_TOTAL_CHARS} total characters.`);
  }

  for (const file of context.files) {
    const normalizedPath = normalizeContextPath(file.path);
    if (seen.has(normalizedPath)) {
      throw new Error(`Duplicate context file: ${normalizedPath}`);
    }
    seen.add(normalizedPath);

    if (typeof file.content !== 'string' || file.content.trim() === '') {
      throw new Error(`Context file is empty: ${normalizedPath}`);
    }
    if (file.content.length > MAX_FILE_CHARS) {
      throw new Error(`Context file exceeds ${MAX_FILE_CHARS} characters: ${normalizedPath}`);
    }
    if (looksBinary(file.content)) {
      throw new Error(`Context file appears to be binary: ${normalizedPath}`);
    }
    if (hasSecretMaterial(file.content)) {
      throw new Error(`Context file appears to contain secret material: ${normalizedPath}`);
    }

    totalChars += file.content.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new Error(`Context exceeds ${MAX_TOTAL_CHARS} total characters.`);
    }

    const computedSha256 = sha256(file.content);
    if (file.sha256 && file.sha256.toLowerCase() !== computedSha256) {
      throw new Error(`Context file hash is stale or incorrect: ${normalizedPath}`);
    }

    const absolutePath = path.resolve(config.rootDir, normalizedPath);
    if (!absolutePath.startsWith(config.rootDir + path.sep) && absolutePath !== config.rootDir) {
      throw new Error(`Context file path escapes the workspace: ${normalizedPath}`);
    }
    if (fs.existsSync(absolutePath)) {
      const diskHash = sha256(fs.readFileSync(absolutePath, 'utf8'));
      if (file.sha256 && diskHash !== file.sha256.toLowerCase()) {
        throw new Error(`Context file is stale relative to disk: ${normalizedPath}`);
      }
      if (file.modified_at) {
        const providedMtime = Date.parse(file.modified_at);
        const diskMtime = fs.statSync(absolutePath).mtimeMs;
        if (Number.isFinite(providedMtime) && diskMtime > providedMtime + 1000) {
          warnings.push(`Context file may be stale relative to disk mtime: ${normalizedPath}.`);
        }
      }
    } else {
      warnings.push(`Context file does not exist on disk and could not be freshness-checked: ${normalizedPath}.`);
    }

    files.push({ ...file, normalizedPath, computedSha256 });
  }

  addCompletenessWarnings(files, `${question}\n${context.notes || ''}`, warnings);

  return {
    files,
    notes: context.notes,
    structured_review: structuredReview,
    warnings: Array.from(new Set(warnings))
  };
}
