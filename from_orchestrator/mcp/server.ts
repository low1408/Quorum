import './patch-console.ts';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initSchema } from '../db/database.ts';
import { runCouncilConsultation } from '../engine/council.ts';
import { runMcqConsultation } from '../engine/mcq.ts';
import { validateCouncilContext } from './contextValidation.ts';
import { SUPPORTED_PROVIDER_IDS, validateProviderList } from '../adapters/registry.ts';
import { saveCouncilReportArtifact } from './reportArtifact.ts';
import { saveMcqReportArtifact } from './mcqReportArtifact.ts';

const contextFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string().optional(),
  modified_at: z.string().optional(),
  relevance: z.string().optional()
});

const structuredReviewSchema = z.object({
  review_objective: z.string(),
  architecture: z.string(),
  execution_flow: z.string(),
  assumptions_and_invariants: z.string(),
  core_evidence: z.string(),
  supporting_contracts: z.string(),
  privacy_and_persistence: z.string(),
  tests_and_runtime_evidence: z.string(),
  omitted_material: z.string()
});

const consultCouncilSchema = {
  question: z.string().min(1),
  context: z.object({
    files: z.array(contextFileSchema).min(1),
    notes: z.string().optional(),
    structured_review: structuredReviewSchema.optional()
  }),
  constraints: z.string().optional(),
  providers: z.array(z.string().min(1)).optional().superRefine((providers, ctx) => {
    if (!providers) return;
    try {
      validateProviderList(providers, 'council providers');
    } catch (err: any) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err?.message || `Supported providers: ${SUPPORTED_PROVIDER_IDS.join(', ')}`
      });
    }
  }),
  max_wait_ms: z.number().int().positive().optional(),
  provider_timeout_ms: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional()
};

export const server = new McpServer({
  name: 'quorum-llm-council',
  version: '0.1.0'
});

server.registerTool(
  'consult_council',
  {
    title: 'Consult Council',
    description: 'Send a coding question and selected repository context to an independent LLM council, then return one consolidated anonymous report.',
    inputSchema: consultCouncilSchema
  },
  async (args) => {
    initSchema();

    const validatedContext = validateCouncilContext(args.context, args.question);
    const result = await runCouncilConsultation({
      question: args.question,
      context: validatedContext,
      constraints: args.constraints,
      providers: args.providers,
      maxWaitMs: args.max_wait_ms,
      providerTimeoutMs: args.provider_timeout_ms,
      maxConcurrency: args.max_concurrency,
      maxRetries: args.max_retries
    });

    const artifact = await saveCouncilReportArtifact(result).catch((err) => {
      console.error('[WARN] Failed to save council report artifact:', err?.message ?? err);
      return null;
    });

    if (artifact) {
      const memberList = artifact.memberPaths.map(m => `  - ${m.provider}: ${m.relativePath}`).join('\n');
      console.error(`[INFO] Council run saved to ${artifact.relativePath}\n${memberList}`);
    }

    const response = artifact ? { ...result, artifact } : result;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ],
      structuredContent: response
    };
  }
);

// ── MCQ Voting Tool ──

const mcqOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional()
});

const mcqCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().positive().optional()
});

const consultCouncilMcqSchema = {
  question: z.string().min(1),
  options: z.array(mcqOptionSchema).min(2).max(10),
  criteria: z.array(mcqCriterionSchema).optional(),
  context: z.object({
    files: z.array(contextFileSchema).optional(),
    notes: z.string().optional()
  }).optional(),
  providers: z.array(z.string().min(1)).optional().superRefine((providers, ctx) => {
    if (!providers) return;
    try {
      validateProviderList(providers, 'MCQ providers');
    } catch (err: any) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err?.message || `Supported providers: ${SUPPORTED_PROVIDER_IDS.join(', ')}`
      });
    }
  }),
  max_wait_ms: z.number().int().positive().optional(),
  provider_timeout_ms: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional()
};

server.registerTool(
  'consult_council_mcq',
  {
    title: 'Council MCQ Vote',
    description: 'Ask the LLM council to vote on predefined options. Each council member independently selects one option and provides justification. Returns the full vote distribution for human review — no winner is declared. Optionally provide evaluation criteria for structured per-option scoring.',
    inputSchema: consultCouncilMcqSchema
  },
  async (args) => {
    initSchema();

    const result = await runMcqConsultation({
      question: args.question,
      options: args.options,
      criteria: args.criteria,
      context: args.context,
      providers: args.providers,
      maxWaitMs: args.max_wait_ms,
      providerTimeoutMs: args.provider_timeout_ms,
      maxConcurrency: args.max_concurrency,
      maxRetries: args.max_retries
    });

    const artifact = await saveMcqReportArtifact(result).catch((err) => {
      console.error('[WARN] Failed to save MCQ report artifact:', err?.message ?? err);
      return null;
    });

    if (artifact) {
      const memberList = artifact.memberPaths.map(m => `  - ${m.provider}: ${m.relativePath}`).join('\n');
      console.error(`[INFO] MCQ vote saved to ${artifact.relativePath}\n${memberList}`);
    }

    const response = artifact ? { ...result, artifact } : result;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ],
      structuredContent: response
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}; shutting down MCP transport.`);
    await transport.close().catch(() => { });
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
