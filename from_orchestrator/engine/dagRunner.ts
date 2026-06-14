import { DBService } from '../db/database.ts';
import type { SessionPoolItem } from './runner.ts';
import { createProviderAdapter } from '../providers/runtime.ts';
import { reviewRegistry } from './reviewRegistry.ts';
import crypto from 'crypto';

function getAncestorNodeIds(nodeId: string, nodesMap: Map<string, any>): Set<string> {
  const ancestors = new Set<string>();
  const queue = [...(nodesMap.get(nodeId)?.dependencies || [])];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (!ancestors.has(curr)) {
      ancestors.add(curr);
      const parentNode = nodesMap.get(curr);
      if (parentNode) {
        queue.push(...(parentNode.dependencies || []));
      }
    }
  }
  return ancestors;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolvePrompt(
  promptTemplate: string,
  node: any,
  nodesMap: Map<string, any>,
  runInputs: Record<string, any>,
  runArtifacts: any[],
  runId: string,
  invocationId: string
): { resolvedPrompt: string; parentArtifacts: string[] } {
  const parentArtifacts: string[] = [];
  const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  
  // Find all ancestors of the node to resolve aliases
  const ancestors = getAncestorNodeIds(node.node_id, nodesMap);
  
  const resolved = promptTemplate.replace(pattern, (match, varName) => {
    // 1. Check if varName matches a workflow input
    if (runInputs[varName] !== undefined) {
      const inputArtifactId = `art_in_${runId}_${varName}`;
      parentArtifacts.push(inputArtifactId);
      return String(runInputs[varName]);
    }
    
    // 2. Check if varName is an alias of an ancestor node
    for (const ancestorId of ancestors) {
      const ancestorNode = nodesMap.get(ancestorId);
      if (!ancestorNode) continue;
      
      const aliases = [
        ancestorNode.node_id,
        ancestorNode.label ? slugify(ancestorNode.label) : '',
        ancestorNode.output?.key || ''
      ].filter(Boolean);
      
      if (aliases.includes(varName)) {
        const ancestorArtifact = runArtifacts.find(art => art.node_id === ancestorId);
        if (ancestorArtifact) {
          parentArtifacts.push(ancestorArtifact.artifact_id);
          try {
            const content = JSON.parse(ancestorArtifact.content_json);
            return content.value !== undefined ? String(content.value) : '';
          } catch {
            return ancestorArtifact.content_json;
          }
        }
      }
    }
    
    return match;
  });
  
  return { resolvedPrompt: resolved, parentArtifacts };
}

function parseArtifactValue(artifact: any): any {
  if (!artifact) return undefined;
  try {
    const parsed = JSON.parse(artifact.content_json);
    return parsed && Object.prototype.hasOwnProperty.call(parsed, 'value') ? parsed.value : parsed;
  } catch {
    return artifact.content_json;
  }
}

function parseScore(value: any, scoreKey = 'score'): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const direct = Number(value[scoreKey]);
    if (Number.isFinite(direct)) return direct;
    const nested = Number(value.value?.[scoreKey]);
    if (Number.isFinite(nested)) return nested;
  }
  const text = String(value ?? '');
  const keyPattern = new RegExp(`${scoreKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:=]\\s*([0-9]*\\.?[0-9]+)`, 'i');
  const keyed = text.match(keyPattern);
  const generic = keyed || text.match(/([0-9]*\.[0-9]+|[0-9]+)/);
  if (!generic) return null;
  const score = Number(generic[1]);
  return Number.isFinite(score) ? score : null;
}

function compareNumbers(actual: number, operator: string, expected: number): boolean {
  switch (operator) {
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '==':
    case '=': return actual === expected;
    default: return actual >= expected;
  }
}

function truthyBranchValue(value: any): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value ?? '').trim().toLowerCase();
}

export class WorkflowExecutor {
  private plan: any;
  private runId: string;
  private inputs: Record<string, any>;
  private globalPagePool: Record<string, SessionPoolItem>;
  private nodesMap = new Map<string, any>();
  private activePromises = new Map<string, Promise<any>>();
  private finishedNodes = new Set<string>();

  constructor(plan: any, runId: string, inputs: Record<string, any>, globalPagePool: Record<string, SessionPoolItem> = {}) {
    this.plan = plan;
    this.runId = runId;
    this.inputs = inputs;
    this.globalPagePool = globalPagePool;
    for (const node of this.plan.nodes) {
      this.nodesMap.set(node.node_id, node);
    }
  }

  public async execute(): Promise<void> {
    console.log(`[SCHEDULER] Starting execution of workflow run ${this.runId}...`);
    
    const exists = DBService.runExists(this.runId);
    if (!exists) {
      // 1. Create run and input artifacts
      const topic = this.inputs.topic || 'Workflow Execution';
      DBService.createWorkflowRun({
        runId: this.runId,
        workflowVersionId: this.plan.workflow_version_id || 'unknown_version',
        topic,
        inputs: this.inputs
      });

      // 2. Pre-materialize node invocations
      DBService.preMaterializeNodeInvocations(this.runId, this.plan.nodes);
    } else {
      DBService.updateRunStatus(this.runId, 'IN_PROGRESS');
      // Initialize finishedNodes with already terminal node invocations from database
      const invocations = DBService.getNodeInvocations(this.runId);
      for (const inv of invocations) {
        if (inv.status === 'COMPLETED' || inv.status === 'FAILED' || inv.status === 'SKIPPED') {
          this.finishedNodes.add(inv.node_id);
        }
      }
    }

    try {
      // 3. Start scheduler loop
      await this.schedulerLoop();

      // 4. Update overall Run status
      const invocations = DBService.getNodeInvocations(this.runId);
      
      let runStatus: 'COMPLETED' | 'PARTIAL_SUCCESS' | 'FAILED' = 'COMPLETED';

      const hasRequiredFailuresOrSkips = invocations.some(inv => {
        const isRequired = inv.required_for_run_success === 1 || inv.required_for_run_success === true;
        return isRequired && (inv.status === 'FAILED' || inv.status === 'SKIPPED');
      });

      if (hasRequiredFailuresOrSkips) {
        runStatus = 'FAILED';
      } else {
        const hasAnyFailuresOrSkips = invocations.some(inv => inv.status === 'FAILED' || inv.status === 'SKIPPED');
        if (hasAnyFailuresOrSkips) {
          runStatus = 'PARTIAL_SUCCESS';
        }
      }

      DBService.updateRunStatus(this.runId, runStatus);
      console.log(`[SCHEDULER] Workflow run ${this.runId} completed with status: ${runStatus}`);
    } catch (err) {
      DBService.updateRunStatus(this.runId, 'FAILED');
      throw err;
    }
  }

  private async schedulerLoop(): Promise<void> {
    while (this.finishedNodes.size < this.plan.nodes.length) {
      const readyNodes = [];
      const invocations = DBService.getNodeInvocations(this.runId);
      const statusMap = new Map<string, string>();
      for (const inv of invocations) {
        statusMap.set(inv.node_id, inv.status);
      }

      for (const node of this.plan.nodes) {
        if (this.finishedNodes.has(node.node_id) || this.activePromises.has(node.node_id)) {
          continue;
        }

        // Check if node is already skipped in the database (e.g. manually skipped by user)
        if (statusMap.get(node.node_id) === 'SKIPPED') {
          this.finishedNodes.add(node.node_id);
          continue;
        }

        const deps = node.dependencies || [];
        const allDepsMet = deps.every((depId: string) => this.finishedNodes.has(depId));
        if (allDepsMet) {
          const branchDecision = this.shouldSkipForBranchPolicy(node, statusMap);
          if (branchDecision.skip) {
            console.log(`[SCHEDULER] Skipping node ${node.node_id}: ${branchDecision.reason}`);
            const invocationId = `inv_${this.runId}_${node.node_id}`;
            DBService.skipNodeInvocation(invocationId);
            this.finishedNodes.add(node.node_id);
            continue;
          }

          const anyParentSkipped = deps.some((depId: string) => statusMap.get(depId) === 'SKIPPED');
          if (anyParentSkipped) {
            console.log(`[SCHEDULER] Skipping node ${node.node_id} because a parent was skipped.`);
            const invocationId = `inv_${this.runId}_${node.node_id}`;
            DBService.skipNodeInvocation(invocationId);
            this.finishedNodes.add(node.node_id);
            continue;
          }
          readyNodes.push(node);
        }
      }

      if (readyNodes.length === 0 && this.activePromises.size === 0) {
        const unexecuted = this.plan.nodes.filter((n: any) => !this.finishedNodes.has(n.node_id));
        if (unexecuted.length > 0) {
          const names = unexecuted.map((n: any) => n.node_id).join(', ');
          throw new Error(`Deadlock detected. Unexecuted nodes: ${names}`);
        }
        break;
      }

      for (const node of readyNodes) {
        const promise = this.executeNode(node);
        this.activePromises.set(node.node_id, promise);
      }

      if (this.activePromises.size > 0) {
        const completedNodeId = await Promise.race(
          Array.from(this.activePromises.entries()).map(async ([nodeId, promise]) => {
            await promise;
            return nodeId;
          })
        );
        this.activePromises.delete(completedNodeId);
        this.finishedNodes.add(completedNodeId);
      }
    }
  }

  private shouldSkipForBranchPolicy(node: any, statusMap: Map<string, string>): { skip: boolean; reason: string } {
    const incomingEdges = node.incoming_edges || (this.plan.edges || []).filter((edge: any) => edge.target_node_id === node.node_id);
    const runArtifacts = DBService.getRunArtifacts(this.runId);

    for (const edge of incomingEdges) {
      const parentStatus = statusMap.get(edge.source_node_id);
      const missingParentPolicy = edge.config?.missing_parent_policy || node.config?.missing_parent_policy || 'skip_child';

      if (parentStatus === 'SKIPPED' && missingParentPolicy === 'skip_child') {
        return { skip: true, reason: `parent ${edge.source_node_id} was skipped` };
      }

      const parentNode = this.nodesMap.get(edge.source_node_id);
      if (parentNode?.type !== 'condition') continue;

      const conditionArtifact = runArtifacts.find(art => art.node_id === edge.source_node_id);
      const conditionValue = parseArtifactValue(conditionArtifact);
      const selectedBranch = truthyBranchValue(conditionValue?.selected_branch ?? conditionValue?.value ?? conditionValue?.result);
      const expected = edge.config?.when ?? edge.config?.branch ?? edge.config?.condition;

      if (expected !== undefined && selectedBranch !== truthyBranchValue(expected)) {
        return {
          skip: true,
          reason: `condition ${edge.source_node_id} selected ${selectedBranch || '<empty>'}, not ${truthyBranchValue(expected)}`
        };
      }
    }

    return { skip: false, reason: '' };
  }

  private evaluateConditionNode(node: any, runArtifacts: any[]): { result: boolean; selectedBranch: string; selected_branch: string; observedValue: any } {
    const config = node.config || {};
    const conditionType = config.condition_type || config.conditionType;
    const sourceNodeId = config.source_node_id || config.sourceNodeId || config.source || (node.dependencies || [])[0];
    const sourceArtifact = runArtifacts.find(art => art.node_id === sourceNodeId);
    const sourceNode = this.nodesMap.get(sourceNodeId);
    const sourceValue = sourceArtifact
      ? parseArtifactValue(sourceArtifact)
      : (sourceNode?.type === 'input'
        ? this.inputs[sourceNode.input_variable || 'topic']
        : this.inputs[config.input_name || config.inputName || 'choice']);

    if (conditionType === 'boolean') {
      const observed = config.value !== undefined ? config.value : sourceValue;
      const result = typeof observed === 'string'
        ? ['true', 'yes', '1', 'pass', 'approved'].includes(observed.trim().toLowerCase())
        : Boolean(observed);
      return { result, selectedBranch: result ? 'true' : 'false', selected_branch: result ? 'true' : 'false', observedValue: observed };
    }

    if (conditionType === 'string_equals' || conditionType === 'human_choice') {
      const observed = conditionType === 'human_choice'
        ? this.inputs[config.input_name || config.inputName || 'choice']
        : sourceValue;
      const expected = String(config.equals ?? config.value ?? '').trim();
      const result = String(observed ?? '').trim() === expected;
      return { result, selectedBranch: result ? 'true' : 'false', selected_branch: result ? 'true' : 'false', observedValue: observed };
    }

    if (conditionType === 'score_threshold') {
      const score = parseScore(sourceValue, config.score_key || config.scoreKey || 'score');
      const threshold = Number(config.threshold);
      if (!Number.isFinite(threshold)) {
        throw new Error(`Condition node ${node.node_id} has invalid score threshold.`);
      }
      if (score === null) {
        throw new Error(`Condition node ${node.node_id} could not extract a numeric score.`);
      }
      const result = compareNumbers(score, config.operator || '>=', threshold);
      return { result, selectedBranch: result ? 'true' : 'false', selected_branch: result ? 'true' : 'false', observedValue: score };
    }

    throw new Error(`Unsupported condition type for ${node.node_id}: ${conditionType}`);
  }

  private async executeNode(node: any): Promise<void> {
    const invocationId = `inv_${this.runId}_${node.node_id}`;
    let attemptId: string | null = null;

    const invocations = DBService.getNodeInvocations(this.runId);
    const existingInv = invocations.find(inv => inv.node_id === node.node_id);
    if (existingInv) {
      if (existingInv.status === 'COMPLETED' || existingInv.status === 'SKIPPED') {
        console.log(`[SCHEDULER] Node ${node.node_id} already finished with status ${existingInv.status}.`);
        return;
      }
      if (existingInv.status === 'FAILED' && existingInv.failure_policy !== 'fail_run') {
        console.log(`[SCHEDULER] Node ${node.node_id} already failed with policy ${existingInv.failure_policy}.`);
        return;
      }
    }
    
    const started = DBService.atomicStartInvocation(invocationId);
    if (!started) {
      console.log(`[SCHEDULER] Node ${node.node_id} already running or finished.`);
      return;
    }

    console.log(`[SCHEDULER] Executing node: ${node.node_id} (${node.type})`);

    try {
      if (node.type === 'input') {
        const varName = node.input_variable || 'topic';
        const artifactId = `art_in_${this.runId}_${varName}`;
        DBService.completeNodeInvocation(invocationId, artifactId);
        console.log(`[SCHEDULER] Input node ${node.node_id} complete.`);
        return;
      }

      const runArtifacts = DBService.getRunArtifacts(this.runId);

      if (node.type === 'condition') {
        const parentArtifacts = (node.dependencies || [])
          .map((parentId: string) => runArtifacts.find(art => art.node_id === parentId))
          .filter(Boolean);

        for (const parentArt of parentArtifacts) {
          DBService.addArtifactLineage(parentArt.artifact_id, invocationId);
        }

        const conditionResult = this.evaluateConditionNode(node, runArtifacts);
        const outputArtifactId = `art_${this.runId}_${node.node_id}`;
        DBService.createArtifact({
          artifactId: outputArtifactId,
          runId: this.runId,
          nodeId: node.node_id,
          artifactType: 'raw_output',
          contentJson: JSON.stringify({ value: conditionResult })
        });
        DBService.completeNodeInvocation(invocationId, outputArtifactId);
        console.log(`[SCHEDULER] Condition node ${node.node_id} selected branch ${conditionResult.selectedBranch}.`);
        return;
      }

      if (node.type === 'human_review') {
        // Find parent artifacts from dependencies
        const parentNodeIds = node.dependencies || [];
        const parentArtifacts: string[] = [];
        for (const parentId of parentNodeIds) {
          const parentArt = runArtifacts.find(art => art.node_id === parentId);
          if (parentArt) {
            parentArtifacts.push(parentArt.artifact_id);
          }
        }

        // Add lineage
        for (const parentArtId of parentArtifacts) {
          DBService.addArtifactLineage(parentArtId, invocationId);
        }

        // Transition status to AWAITING_HUMAN_REVIEW
        DBService.setInvocationAwaitingReview(invocationId);
        console.log(`[SCHEDULER] Node ${node.node_id} is awaiting human review. Pausing execution...`);

        // Wait for registry response
        const reviewResult = await reviewRegistry.registerReview(this.runId, node.node_id);

        // Resume Run status to IN_PROGRESS
        DBService.updateRunStatus(this.runId, 'IN_PROGRESS');

        const reviewId = `rev_${crypto.randomUUID()}`;
        const rawArtifactId = parentArtifacts[0] || `art_in_${this.runId}_topic`; // fallback if no parent
        
        let finalOutputArtifactId = `art_${this.runId}_${node.node_id}`;
        let reviewedArtifactId: string | null = null;

        if (reviewResult.decision === 'APPROVED') {
          const firstParentArtId = parentArtifacts[0];
          if (firstParentArtId) {
            finalOutputArtifactId = firstParentArtId;
          } else {
            // Fallback: create empty artifact if no parent
            DBService.createArtifact({
              artifactId: finalOutputArtifactId,
              runId: this.runId,
              nodeId: node.node_id,
              artifactType: 'reviewed_output',
              contentJson: JSON.stringify({ value: '' })
            });
          }
        } else if (reviewResult.decision === 'EDITED') {
          reviewedArtifactId = finalOutputArtifactId;
          DBService.createArtifact({
            artifactId: finalOutputArtifactId,
            runId: this.runId,
            nodeId: node.node_id,
            artifactType: 'reviewed_output',
            contentJson: JSON.stringify({ value: reviewResult.editedContent })
          });
        }

        // Record the HumanReviewEvent
        DBService.recordHumanReview({
          reviewId,
          runId: this.runId,
          nodeId: node.node_id,
          invocationId,
          rawArtifactId,
          reviewedArtifactId,
          decision: reviewResult.decision
        });

        if (reviewResult.decision === 'REJECTED') {
          const failurePolicy = node.config?.failure_policy || 'fail_run';
          const err = new Error('Human review rejected');
          DBService.failNodeInvocation(invocationId, err.message);

          if (failurePolicy === 'continue_with_warning') {
            console.log(`[SCHEDULER] Human review rejected with continue_with_warning policy.`);
            return;
          } else if (failurePolicy === 'skip_branch') {
            console.log(`[SCHEDULER] Human review rejected with skip_branch policy.`);
            DBService.skipNodeInvocation(invocationId);
            return;
          } else {
            throw err;
          }
        }

        DBService.completeNodeInvocation(invocationId, finalOutputArtifactId);
        console.log(`[SCHEDULER] Human review node ${node.node_id} complete (decision: ${reviewResult.decision}).`);
        return;
      }

      const { resolvedPrompt, parentArtifacts } = resolvePrompt(
        node.prompt_template,
        node,
        this.nodesMap,
        this.inputs,
        runArtifacts,
        this.runId,
        invocationId
      );

      for (const parentArtId of parentArtifacts) {
        DBService.addArtifactLineage(parentArtId, invocationId);
      }

      const retryPolicy = node.config?.retry_policy || {};
      const maxRetries = retryPolicy.max_retries !== undefined ? Number(retryPolicy.max_retries) : (node.config?.max_retries !== undefined ? Number(node.config.max_retries) : 0);
      const retryBackoffMs = retryPolicy.retry_backoff_ms !== undefined ? Number(retryPolicy.retry_backoff_ms) : (node.config?.retry_backoff_ms !== undefined ? Number(node.config.retry_backoff_ms) : 0);
      const failurePolicy = node.config?.failure_policy || 'fail_run';

      let attemptNo = 1;
      let success = false;
      let lastError: any = null;

      const provider = node.provider || 'mock';
      const providerAdapter = createProviderAdapter(provider, {
        sessionPoolItem: this.globalPagePool[provider]
      });

      while (attemptNo <= maxRetries + 1) {
        attemptId = `attempt_${this.runId}_${node.node_id}_${attemptNo}_${Date.now()}`;
        console.log(`[SCHEDULER] Node ${node.node_id} execution attempt ${attemptNo}/${maxRetries + 1}...`);
        
        DBService.createTaskAttempt({
          attemptId,
          invocationId,
          attemptNo,
          providerName: provider,
          promptPayload: resolvedPrompt,
          status: 'RUNNING'
        });

        try {
          const result = await providerAdapter.execute({
            attempt_id: attemptId,
            run_id: this.runId,
            invocation_id: invocationId,
            provider_id: provider,
            prompt: resolvedPrompt
          });

          DBService.completeTaskAttempt(attemptId, result.raw_response_text, {
            threadUrl: result.thread_url || null,
            contextMode: result.context_mode,
            contextFidelity: result.context_fidelity,
            adapterStateJson: result.adapter_state_json || null
          });

          const outputArtifactId = `art_${this.runId}_${node.node_id}`;
          DBService.createArtifact({
            artifactId: outputArtifactId,
            runId: this.runId,
            nodeId: node.node_id,
            artifactType: node.type === 'synthesizer' ? 'synthesis' : 'raw_output',
            contentJson: JSON.stringify({ value: result.raw_response_text })
          });

          DBService.completeNodeInvocation(invocationId, outputArtifactId);
          console.log(`[SCHEDULER] Node ${node.node_id} completed successfully on attempt ${attemptNo}.`);
          success = true;
          break;
        } catch (err: any) {
          console.error(`[SCHEDULER] Attempt ${attemptNo} for node ${node.node_id} failed: ${err.message}`);
          if (err.code === 'INTERVENTION_REQUIRED' || /INTERVENTION_REQUIRED|AUTH_EXPIRED|CAPTCHA|manual intervention/i.test(err.message)) {
            DBService.markTaskAttemptInterventionRequired(attemptId, err.message);
            DBService.setInvocationInterventionRequired(invocationId, err.message);
            DBService.updateRunStatus(this.runId, 'INTERVENTION_REQUIRED');
            throw err;
          }
          DBService.failTaskAttempt(attemptId, err.message);
          lastError = err;
          attemptNo++;

          if (attemptNo <= maxRetries + 1 && retryBackoffMs > 0) {
            console.log(`[SCHEDULER] Waiting ${retryBackoffMs}ms before next retry...`);
            await new Promise(resolve => setTimeout(resolve, retryBackoffMs));
          }
        }
      }

      if (!success) {
        console.error(`[SCHEDULER] All ${maxRetries + 1} attempts failed for node ${node.node_id}.`);
        if (failurePolicy === 'continue_with_warning') {
          console.log(`[SCHEDULER] Policy is 'continue_with_warning'. Setting invocation status to FAILED but not aborting.`);
          DBService.failNodeInvocation(invocationId, lastError.message);
        } else if (failurePolicy === 'skip_branch') {
          console.log(`[SCHEDULER] Policy is 'skip_branch'. Skipping this node.`);
          DBService.skipNodeInvocation(invocationId);
        } else {
          // Default: fail_run
          console.log(`[SCHEDULER] Policy is 'fail_run'. Aborting execution.`);
          DBService.failNodeInvocation(invocationId, lastError.message);
          throw lastError;
        }
      }

    } catch (err: any) {
      console.error(`[SCHEDULER] Node ${node.node_id} failed: ${err.message}`);
      const currentInvs = DBService.getNodeInvocations(this.runId);
      const matchingInv = currentInvs.find(inv => inv.node_id === node.node_id);
      if (matchingInv && matchingInv.status === 'RUNNING') {
        if (attemptId) {
          DBService.failTaskAttempt(attemptId, err.message);
        }
        DBService.failNodeInvocation(invocationId, err.message);
      }
      throw err;
    }
  }
}
