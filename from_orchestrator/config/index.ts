import dotenv from 'dotenv';
import path from 'path';

const rootDir = process.env.COUNCIL_WORKSPACE_ROOT
  ? path.resolve(process.env.COUNCIL_WORKSPACE_ROOT)
  : process.cwd();

// Keep test runs hermetic; package scripts set the required test env explicitly.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(rootDir, '.env') });
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

export const config = {
  encryptionKey: process.env.ENCRYPTION_KEY || 'default_fallback_secret_key_32_chars_long',
  databasePath: process.env.DATABASE_PATH ? path.resolve(rootDir, process.env.DATABASE_PATH) : path.resolve(rootDir, './orchestrator.db'),
  headless: shouldLaunchHeadless(process.env.HEADLESS),
  cdpEndpoint: normalizeCdpEndpoint(process.env.CDP_ENDPOINT),
  evaluatorProvider: process.env.EVALUATOR_PROVIDER || 'gemini',
  enableSummaryEvaluation: false,
  enableCouncilEvaluation: process.env.ENABLE_COUNCIL_EVALUATION !== 'false',
  councilEvaluationMode: process.env.COUNCIL_EVALUATION_MODE || 'inline',
  councilEvaluationVersion: process.env.COUNCIL_EVALUATION_VERSION || 'deterministic-v1',
  humanTyping: process.env.HUMAN_TYPING !== 'false',
  chatgptBaseUrl: process.env.CHATGPT_BASE_URL || 'https://chatgpt.com',
  sessionStorageDir: path.resolve(rootDir, './sessions'),
  limitDebateResponses: process.env.LIMIT_DEBATE_RESPONSES !== 'false',
  requireStructuredReviewContext: process.env.REQUIRE_STRUCTURED_REVIEW_CONTEXT === 'true',
  rootDir,
};

// Simple sanity check
if (config.encryptionKey.length < 32) {
  console.warn('WARNING: ENCRYPTION_KEY is shorter than 32 characters. Encryption strength might be compromised.');
}
