import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

export const config = {
  encryptionKey: process.env.ENCRYPTION_KEY || 'default_fallback_secret_key_32_chars_long',
  databasePath: process.env.DATABASE_PATH ? path.resolve(rootDir, process.env.DATABASE_PATH) : path.resolve(rootDir, './orchestrator.db'),
  headless: process.env.HEADLESS === 'true',
  cdpEndpoint: process.env.CDP_ENDPOINT || '',
  evaluatorProvider: process.env.EVALUATOR_PROVIDER || 'gemini',
  enableSummaryEvaluation: false,
  humanTyping: process.env.HUMAN_TYPING !== 'false',
  chatgptBaseUrl: process.env.CHATGPT_BASE_URL || 'https://chatgpt.com',
  sessionStorageDir: path.resolve(rootDir, './sessions'),
  limitDebateResponses: process.env.LIMIT_DEBATE_RESPONSES !== 'false',
  rootDir,
};

// Simple sanity check
if (config.encryptionKey.length < 32) {
  console.warn('WARNING: ENCRYPTION_KEY is shorter than 32 characters. Encryption strength might be compromised.');
}
