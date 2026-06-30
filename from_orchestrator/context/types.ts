export type CouncilContextFile = {
  path: string;
  content: string;
  sha256?: string;
  modified_at?: string;
  relevance?: string;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
  is_excerpt?: boolean;
};

export type CouncilContext = {
  schema_version?: string;
  files: CouncilContextFile[];
  notes?: string;
  evidence_manifest?: CouncilEvidenceManifestItem[];
  structured_review?: CouncilStructuredReviewContext;
};

export type ValidatedCouncilContext = {
  schema_version?: string;
  files: Array<CouncilContextFile & {
    normalizedPath: string;
    computedSha256: string;
    evidenceId: string;
    role: CouncilEvidenceRole;
    provenance: CouncilEvidenceProvenance;
    order?: number;
    startLine: number;
    endLine: number;
    totalLines: number;
    isExcerpt: boolean;
  }>;
  notes?: string;
  evidence_manifest?: CouncilEvidenceManifestItem[];
  structured_review?: CouncilStructuredReviewContext;
  warnings: string[];
  context_digest: string;
};

export type CouncilEvidenceRole = 'core' | 'contract' | 'config' | 'test' | 'runtime' | 'supporting';
export type CouncilEvidenceProvenance = 'repository' | 'generated' | 'test-runtime' | 'caller-supplied';

export type CouncilEvidenceManifestItem = {
  id: string;
  path: string;
  sha256?: string;
  role: CouncilEvidenceRole;
  provenance: CouncilEvidenceProvenance;
  relevance: string;
  order?: number;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
  is_excerpt?: boolean;
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

export type CouncilContextValidationOptions = {
  workspaceRoot?: string;
};
