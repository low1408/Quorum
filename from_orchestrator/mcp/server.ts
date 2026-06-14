import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initSchema } from '../db/database.ts';
import { runCouncilConsultation } from '../engine/council.ts';
import { validateCouncilContext } from './contextValidation.ts';
import { SUPPORTED_PROVIDER_IDS, validateProviderList } from '../adapters/registry.ts';

const contextFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string().optional(),
  modified_at: z.string().optional(),
  relevance: z.string().optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  total_lines: z.number().int().positive().optional(),
  is_excerpt: z.boolean().optional()
}).strict();

const evidenceManifestItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  sha256: z.string().optional(),
  role: z.enum(['core', 'contract', 'config', 'test', 'runtime', 'supporting']),
  provenance: z.enum(['repository', 'generated', 'test-runtime', 'caller-supplied']),
  relevance: z.string(),
  order: z.number().int().optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  total_lines: z.number().int().positive().optional(),
  is_excerpt: z.boolean().optional()
}).strict();

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
}).strict();

const consultCouncilSchema = {
  question: z.string().min(1),
  context: z.object({
    schema_version: z.string().optional(),
    files: z.array(contextFileSchema).min(1),
    notes: z.string().optional(),
    evidence_manifest: z.array(evidenceManifestItemSchema).optional(),
    structured_review: structuredReviewSchema.optional()
  }).strict(),
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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  }
);

async function main(): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  const transport = new StdioServerTransport();
  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}; shutting down MCP transport.`);
    await transport.close().catch(() => {});
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
