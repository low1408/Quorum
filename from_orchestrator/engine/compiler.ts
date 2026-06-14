export const COMPILER_VERSION = 'phase1-minimal-compiler-0.1.0';

type WorkflowInputDefinition = {
  name: string;
  type: 'string' | 'number' | 'file';
  required: number | boolean;
};

type GraphNode = {
  id: string;
  type?: string;
  label?: string;
  x?: number;
  y?: number;
  position?: { x?: number; y?: number };
  config?: Record<string, any>;
  data?: Record<string, any>;
};

type GraphEdge = {
  id?: string;
  source: string;
  target: string;
  type?: string;
  config?: Record<string, any>;
  data?: Record<string, any>;
};

type WorkflowGraph = {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  viewport?: Record<string, any>;
};

type ValidationReport = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

type NormalizedNode = {
  node_id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  provider: string | null;
  prompt_template: string;
  input_variable: string | null;
  output: { key: string; artifact_type: string };
  config: Record<string, any>;
};

type NormalizedEdge = {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  type: 'execution' | 'data_flow';
  config: Record<string, any>;
};

function extractPromptVariables(prompt: string): string[] {
  const variables = new Set<string>();
  const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt)) !== null) {
    variables.add(match[1]);
  }

  return Array.from(variables);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function nodeOutputAliases(node: NormalizedNode): string[] {
  return Array.from(new Set([
    node.node_id,
    slugify(node.label),
    node.output.key
  ].filter(Boolean)));
}

function normalizeNode(node: GraphNode): NormalizedNode {
  const config = node.config || node.data?.config || {};
  const nodeType = node.type || 'llm';
  const label = node.label || node.data?.label || node.id;
  const outputKey = String(config.output_key || node.id);

  return {
    node_id: node.id,
    type: nodeType,
    label,
    position: {
      x: node.x ?? node.position?.x ?? 0,
      y: node.y ?? node.position?.y ?? 0
    },
    provider: typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : null,
    prompt_template: config.prompt || '',
    input_variable: nodeType === 'input' && config.variable ? String(config.variable).trim() : null,
    output: {
      key: outputKey,
      artifact_type: nodeType === 'input'
        ? 'input'
        : (nodeType === 'human_review'
          ? 'reviewed_output'
          : (nodeType === 'synthesizer' ? 'synthesis' : 'raw_output'))
    },
    config
  };
}

function normalizeEdge(edge: GraphEdge): NormalizedEdge {
  const edgeType = edge.type || 'execution';
  return {
    edge_id: edge.id || `${edge.source}->${edge.target}`,
    source_node_id: edge.source,
    target_node_id: edge.target,
    type: edgeType === 'data_flow' ? 'data_flow' : 'execution',
    config: edge.config || edge.data?.config || {}
  };
}

function buildIncomingMap(nodes: NormalizedNode[], edges: NormalizedEdge[]): Map<string, NormalizedEdge[]> {
  const incoming = new Map(nodes.map(node => [node.node_id, [] as NormalizedEdge[]]));
  for (const edge of edges) {
    incoming.get(edge.target_node_id)?.push(edge);
  }
  return incoming;
}

function buildOutgoingMap(nodes: NormalizedNode[], edges: NormalizedEdge[]): Map<string, NormalizedEdge[]> {
  const outgoing = new Map(nodes.map(node => [node.node_id, [] as NormalizedEdge[]]));
  for (const edge of edges) {
    outgoing.get(edge.source_node_id)?.push(edge);
  }
  return outgoing;
}

function topologicalSort(nodes: NormalizedNode[], edges: NormalizedEdge[]): string[] | null {
  const indegree = new Map(nodes.map(node => [node.node_id, 0]));
  const outgoing = buildOutgoingMap(nodes, edges);

  for (const edge of edges) {
    indegree.set(edge.target_node_id, (indegree.get(edge.target_node_id) || 0) + 1);
  }

  const graphOrder = new Map(nodes.map((node, index) => [node.node_id, index]));
  const queue = nodes
    .filter(node => (indegree.get(node.node_id) || 0) === 0)
    .sort((a, b) => (graphOrder.get(a.node_id) || 0) - (graphOrder.get(b.node_id) || 0));
  const ordered: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    ordered.push(node.node_id);

    for (const edge of outgoing.get(node.node_id) || []) {
      const nextIndegree = (indegree.get(edge.target_node_id) || 0) - 1;
      indegree.set(edge.target_node_id, nextIndegree);

      if (nextIndegree === 0) {
        const nextNode = nodes.find(candidate => candidate.node_id === edge.target_node_id);
        if (nextNode) {
          queue.push(nextNode);
          queue.sort((a, b) => (graphOrder.get(a.node_id) || 0) - (graphOrder.get(b.node_id) || 0));
        }
      }
    }
  }

  return ordered.length === nodes.length ? ordered : null;
}

function reachableFromRoots(nodes: NormalizedNode[], edges: NormalizedEdge[]): Set<string> {
  const incoming = buildIncomingMap(nodes, edges);
  const outgoing = buildOutgoingMap(nodes, edges);
  const inputRoots = nodes.filter(node => node.type === 'input').map(node => node.node_id);
  const structuralRoots = nodes
    .filter(node => (incoming.get(node.node_id) || []).length === 0)
    .map(node => node.node_id);
  const roots = inputRoots.length > 0 ? inputRoots : structuralRoots;
  const visited = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    for (const edge of outgoing.get(nodeId) || []) {
      queue.push(edge.target_node_id);
    }
  }

  return visited;
}

function collectAncestorAliases(
  nodeId: string,
  nodesById: Map<string, NormalizedNode>,
  incoming: Map<string, NormalizedEdge[]>
): Set<string> {
  const aliases = new Set<string>();
  const visited = new Set<string>();
  const queue = [...(incoming.get(nodeId) || []).map(edge => edge.source_node_id)];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const node = nodesById.get(currentId);
    if (node) {
      for (const alias of nodeOutputAliases(node)) {
        aliases.add(alias);
      }
    }

    for (const edge of incoming.get(currentId) || []) {
      queue.push(edge.source_node_id);
    }
  }

  return aliases;
}

export function compileWorkflowDraft(graphJson: string, inputs: WorkflowInputDefinition[]): {
  sourceGraphJson: string;
  compiledPlanJson: string;
  validationReportJson: string;
  validationReport: ValidationReport;
} {
  const report: ValidationReport = {
    valid: true,
    errors: [],
    warnings: []
  };

  let graph: WorkflowGraph;
  try {
    graph = JSON.parse(graphJson);
  } catch (err: any) {
    report.valid = false;
    report.errors.push(`Draft graph_json is not valid JSON: ${err.message}`);
    return {
      sourceGraphJson: graphJson,
      compiledPlanJson: JSON.stringify({ compiler_version: COMPILER_VERSION, nodes: [], edges: [] }, null, 2),
      validationReportJson: JSON.stringify(report, null, 2),
      validationReport: report
    };
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const inputNames = new Set(inputs.map(input => input.name));
  const nodeIds = new Set<string>();
  const supportedEdgeTypes = new Set(['execution', 'data_flow']);

  if (nodes.length === 0) {
    report.errors.push('Draft must contain at least one node.');
  }

  for (const node of nodes) {
    if (!node.id) {
      report.errors.push('Every node must have an id.');
      continue;
    }

    if (nodeIds.has(node.id)) {
      report.errors.push(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);

    const nodeType = node.type || 'llm';
    const config = node.config || node.data?.config || {};
    if (nodeType === 'input') {
      if (!config.variable || !String(config.variable).trim()) {
        report.errors.push(`Input node ${node.id} must declare config.variable.`);
      } else if (!inputNames.has(String(config.variable).trim())) {
        report.errors.push(`Input node ${node.id} references undefined workflow input: ${String(config.variable).trim()}`);
      }
    } else if (nodeType === 'human_review' || nodeType === 'condition') {
      // Human review and condition nodes do not require a model provider.
      if (nodeType === 'condition') {
        const conditionType = String(config.condition_type || config.conditionType || '').trim();
        const supportedConditions = new Set(['boolean', 'string_equals', 'score_threshold', 'human_choice']);
        if (!conditionType) {
          report.errors.push(`Condition node ${node.id} must declare config.condition_type.`);
        } else if (!supportedConditions.has(conditionType)) {
          report.errors.push(`Condition node ${node.id} has unsupported condition_type: ${conditionType}`);
        }
      }
    } else {
      if (!config.provider || typeof config.provider !== 'string' || !config.provider.trim()) {
        report.errors.push(`Node ${node.id} must declare exactly one provider in config.provider.`);
      }

      if (Array.isArray(config.providers) && config.providers.length > 0) {
        report.errors.push(`Node ${node.id} declares multiple providers; Phase 1 supports one provider per node.`);
      }
    }
  }

  for (const edge of edges) {
    if (!edge.source || !edge.target) {
      report.errors.push(`Edge ${edge.id || '<unnamed>'} must include source and target.`);
      continue;
    }

    if (!nodeIds.has(edge.source)) {
      report.errors.push(`Edge ${edge.id || '<unnamed>'} references missing source node: ${edge.source}`);
    }

    if (!nodeIds.has(edge.target)) {
      report.errors.push(`Edge ${edge.id || '<unnamed>'} references missing target node: ${edge.target}`);
    }

    if (!supportedEdgeTypes.has(edge.type || 'execution')) {
      report.errors.push(`Edge ${edge.id || '<unnamed>'} has unsupported type: ${edge.type}`);
    }

    const sourceNode = nodes.find(node => node.id === edge.source);
    if (sourceNode?.type === 'condition') {
      const config = edge.config || edge.data?.config || {};
      const hasBranchPolicy = config.when !== undefined || config.branch !== undefined || config.condition !== undefined;
      if (!hasBranchPolicy) {
        report.warnings.push(`Branch edge ${edge.id || `${edge.source}->${edge.target}`} has no config.when/config.branch; it will always be eligible.`);
      }
    }
  }

  const normalizedNodes = nodes.filter(node => node.id).map(normalizeNode);
  const normalizedEdges = edges
    .filter(edge => edge.source && edge.target && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map(normalizeEdge);
  const nodesById = new Map(normalizedNodes.map(node => [node.node_id, node]));
  const incoming = buildIncomingMap(normalizedNodes, normalizedEdges);
  const reachable = reachableFromRoots(normalizedNodes, normalizedEdges);
  const executionOrder = topologicalSort(normalizedNodes, normalizedEdges);

  if (!executionOrder && normalizedNodes.length > 0) {
    report.errors.push('Graph contains a cycle. Phase 1 supports DAG workflows only.');
  }

  for (const node of normalizedNodes) {
    if (!reachable.has(node.node_id)) {
      report.errors.push(`Node ${node.node_id} is not reachable from an input/root node.`);
    }
  }

  const inputNodeVariables = normalizedNodes
    .filter(node => node.type === 'input' && node.input_variable)
    .map(node => node.input_variable as string);
  const globalVariables = new Set([...inputNames, ...inputNodeVariables]);

  for (const node of normalizedNodes) {
    const ancestorAliases = collectAncestorAliases(node.node_id, nodesById, incoming);
    for (const variable of extractPromptVariables(node.prompt_template)) {
      if (!globalVariables.has(variable) && !ancestorAliases.has(variable)) {
        report.errors.push(`Node ${node.node_id} references unresolved prompt variable: ${variable}`);
      }
    }
  }

  report.valid = report.errors.length === 0;

  const compiledPlan = {
    compiler_version: COMPILER_VERSION,
    created_from: 'WorkflowDraft.graph_json',
    inputs: inputs.map(input => ({
      name: input.name,
      type: input.type,
      required: input.required === true || input.required === 1
    })),
    execution_order: executionOrder || [],
    nodes: normalizedNodes.map(node => ({
      ...node,
      dependencies: (incoming.get(node.node_id) || []).map(edge => edge.source_node_id),
      incoming_edges: incoming.get(node.node_id) || []
    })),
    edges: normalizedEdges,
    execution_edges: normalizedEdges.filter(edge => edge.type === 'execution'),
    data_flow_edges: normalizedEdges.filter(edge => edge.type === 'data_flow')
  };

  return {
    sourceGraphJson: JSON.stringify(graph, null, 2),
    compiledPlanJson: JSON.stringify(compiledPlan, null, 2),
    validationReportJson: JSON.stringify(report, null, 2),
    validationReport: report
  };
}
