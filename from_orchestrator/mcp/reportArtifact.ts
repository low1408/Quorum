import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.ts';
import type { CouncilConsultationResult } from '../engine/council.ts';

export type CouncilReportArtifact = {
  absolutePath: string;
  relativePath: string;
};

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildCouncilReportMarkdown(result: CouncilConsultationResult): string {
  const warnings = result.warnings.length > 0
    ? result.warnings.map(warning => `- ${warning}`).join('\n')
    : '- None';

  return [
    `# Council Report`,
    '',
    `Run ID: ${result.run_id}`,
    `Status: ${result.status}`,
    '',
    '## Report',
    '',
    result.report.trim(),
    '',
    '## Warnings',
    '',
    warnings,
    ''
  ].join('\n');
}

export async function saveCouncilReportArtifact(result: CouncilConsultationResult): Promise<CouncilReportArtifact> {
  const relativePath = path.join('quorum', `${safeRunId(result.run_id)}.md`);
  const absolutePath = path.resolve(config.rootDir, relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buildCouncilReportMarkdown(result), 'utf8');

  return { absolutePath, relativePath };
}
