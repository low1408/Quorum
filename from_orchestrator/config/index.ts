import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const defaultWorkspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dotenvRoot = process.env.COUNCIL_WORKSPACE_ROOT
  ? path.resolve(process.env.COUNCIL_WORKSPACE_ROOT)
  : defaultWorkspaceRoot;

// Keep test runs hermetic; package scripts set the required test env explicitly.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(dotenvRoot, '.env') });
}

export function resolveWorkspaceRoot(value: string | undefined = process.env.COUNCIL_WORKSPACE_ROOT): string {
  return value ? path.resolve(value) : defaultWorkspaceRoot;
}

export function normalizeCdpEndpoint(value: string | undefined): string {
  const endpoint = value?.trim() || '';
  if (!endpoint) return '';
  if (/^\d+$/.test(endpoint)) return `http://127.0.0.1:${endpoint}`;
  if (/^[\w.-]+:\d+$/.test(endpoint)) return `http://${endpoint}`;
  return endpoint;
}

export function shouldLaunchHeadless(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (value === 'true') return true;
  if (value === 'false') {
    return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  }
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function requireEncryptionKey(value: string | undefined = process.env.ENCRYPTION_KEY): string {
  const key = value?.trim();
  if (!key) {
    throw new Error('ENCRYPTION_KEY is required to read or write encrypted browser sessions.');
  }
  if (key.length < 32) {
    throw new Error('ENCRYPTION_KEY must contain at least 32 characters.');
  }
  return key;
}

export type RuntimeConfig = Readonly<{
  encryptionKey?: string;
  databasePath: string;
  headless: boolean;
  cdpEndpoint: string;
  evaluatorProvider: string;
  enableSummaryEvaluation: boolean;
  enableCouncilEvaluation: boolean;
  councilEvaluationMode: string;
  councilEvaluationVersion: string;
  humanTyping: boolean;
  chatgptBaseUrl: string;
  sessionStorageDir: string;
  limitDebateResponses: boolean;
  requireStructuredReviewContext: boolean;
  rootDir: string;
}>;

export function createRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): RuntimeConfig {
  const rootDir = resolveWorkspaceRoot(env.COUNCIL_WORKSPACE_ROOT);
  return Object.freeze({
    encryptionKey: env.ENCRYPTION_KEY,
    databasePath: env.DATABASE_PATH ? path.resolve(rootDir, env.DATABASE_PATH) : path.resolve(rootDir, './orchestrator.db'),
    headless: shouldLaunchHeadless(env.HEADLESS, env, platform),
    cdpEndpoint: normalizeCdpEndpoint(env.CDP_ENDPOINT),
    evaluatorProvider: env.EVALUATOR_PROVIDER || 'gemini',
    enableSummaryEvaluation: false,
    enableCouncilEvaluation: env.ENABLE_COUNCIL_EVALUATION !== 'false',
    councilEvaluationMode: env.COUNCIL_EVALUATION_MODE || 'inline',
    councilEvaluationVersion: env.COUNCIL_EVALUATION_VERSION || 'deterministic-v1',
    humanTyping: env.HUMAN_TYPING !== 'false',
    chatgptBaseUrl: env.CHATGPT_BASE_URL || 'https://chatgpt.com',
    sessionStorageDir: path.resolve(rootDir, './sessions'),
    limitDebateResponses: env.LIMIT_DEBATE_RESPONSES !== 'false',
    requireStructuredReviewContext: env.REQUIRE_STRUCTURED_REVIEW_CONTEXT === 'true',
    rootDir
  });
}

export const config = createRuntimeConfig();
