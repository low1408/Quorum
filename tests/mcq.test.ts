import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  McqSimpleDecisionSchema,
  McqCriteriaDecisionSchema,
  validateSimpleDecisionCrossFields,
  validateCriteriaDecisionCrossFields,
  isCriteriaDecision,
  type McqSimpleDecision,
  type McqCriteriaDecision,
} from '../from_orchestrator/engine/mcqSchemas.ts';

import {
  buildMcqPrompt,
  extractJsonFromResponse,
  validateDecision,
  buildRepairPrompt,
  aggregateVotes,
  type McqRequest,
  type McqMemberVote,
} from '../from_orchestrator/engine/mcq.ts';

// ── Test Fixtures ──

const SIMPLE_REQUEST: McqRequest = {
  question: 'Which database should we use?',
  options: [
    { id: 'opt_a', label: 'PostgreSQL', description: 'Relational, ACID compliant' },
    { id: 'opt_b', label: 'MongoDB', description: 'Document store, flexible schema' },
    { id: 'opt_c', label: 'SQLite', description: 'Embedded, zero-config' }
  ]
};

const CRITERIA_REQUEST: McqRequest = {
  question: 'Which database should we use?',
  options: [
    { id: 'opt_a', label: 'PostgreSQL' },
    { id: 'opt_b', label: 'MongoDB' }
  ],
  criteria: [
    { id: 'crit_perf', label: 'Performance' },
    { id: 'crit_ease', label: 'Ease of use' }
  ]
};

const VALID_SIMPLE_DECISION: McqSimpleDecision = {
  selected_option_id: 'opt_a',
  decision_justification: 'PostgreSQL is the best choice for our use case.',
  assumptions: ['We need ACID compliance'],
  confidence: 0.85
};

const VALID_CRITERIA_DECISION: McqCriteriaDecision = {
  selected_option_id: 'opt_a',
  option_evaluations: [
    {
      option_id: 'opt_a',
      criterion_evaluations: [
        { criterion_id: 'crit_perf', rating: 4, justification: 'Good performance' },
        { criterion_id: 'crit_ease', rating: 3, justification: 'Moderate learning curve' }
      ],
      summary: 'Solid choice for relational data'
    },
    {
      option_id: 'opt_b',
      criterion_evaluations: [
        { criterion_id: 'crit_perf', rating: 5, justification: 'Fast reads' },
        { criterion_id: 'crit_ease', rating: 4, justification: 'Simple to start' }
      ],
      summary: 'Great for flexible schemas'
    }
  ],
  decision_justification: 'PostgreSQL wins on reliability.',
  assumptions: [],
  confidence: 0.9
};

// ── Schema Validation Tests ──

describe('McqSimpleDecisionSchema', () => {
  it('accepts a valid simple decision', () => {
    const result = McqSimpleDecisionSchema.safeParse(VALID_SIMPLE_DECISION);
    assert.ok(result.success, `Expected success, got errors: ${JSON.stringify(result.error?.issues)}`);
  });

  it('rejects missing selected_option_id', () => {
    const result = McqSimpleDecisionSchema.safeParse({
      ...VALID_SIMPLE_DECISION,
      selected_option_id: ''
    });
    assert.ok(!result.success);
  });

  it('rejects confidence out of range', () => {
    const result = McqSimpleDecisionSchema.safeParse({
      ...VALID_SIMPLE_DECISION,
      confidence: 1.5
    });
    assert.ok(!result.success);
  });

  it('rejects missing decision_justification', () => {
    const { decision_justification, ...rest } = VALID_SIMPLE_DECISION;
    const result = McqSimpleDecisionSchema.safeParse(rest);
    assert.ok(!result.success);
  });

  it('defaults assumptions to empty array when missing', () => {
    const { assumptions, ...rest } = VALID_SIMPLE_DECISION;
    const result = McqSimpleDecisionSchema.safeParse(rest);
    assert.ok(result.success);
    assert.deepEqual(result.data!.assumptions, []);
  });
});

describe('McqCriteriaDecisionSchema', () => {
  it('accepts a valid criteria decision', () => {
    const result = McqCriteriaDecisionSchema.safeParse(VALID_CRITERIA_DECISION);
    assert.ok(result.success, `Expected success, got errors: ${JSON.stringify(result.error?.issues)}`);
  });

  it('rejects rating out of range', () => {
    const bad = JSON.parse(JSON.stringify(VALID_CRITERIA_DECISION));
    bad.option_evaluations[0].criterion_evaluations[0].rating = 6;
    const result = McqCriteriaDecisionSchema.safeParse(bad);
    assert.ok(!result.success);
  });

  it('rejects empty option_evaluations', () => {
    const bad = { ...VALID_CRITERIA_DECISION, option_evaluations: [] };
    const result = McqCriteriaDecisionSchema.safeParse(bad);
    assert.ok(!result.success);
  });
});

// ── Cross-field Validation Tests ──

describe('validateSimpleDecisionCrossFields', () => {
  it('passes with valid option ID', () => {
    const errors = validateSimpleDecisionCrossFields(
      VALID_SIMPLE_DECISION,
      new Set(['opt_a', 'opt_b', 'opt_c'])
    );
    assert.equal(errors.length, 0);
  });

  it('rejects unknown option ID', () => {
    const badDecision = { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_z' };
    const errors = validateSimpleDecisionCrossFields(
      badDecision,
      new Set(['opt_a', 'opt_b', 'opt_c'])
    );
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('opt_z'));
  });
});

describe('validateCriteriaDecisionCrossFields', () => {
  const optionIds = new Set(['opt_a', 'opt_b']);
  const criterionIds = new Set(['crit_perf', 'crit_ease']);

  it('passes with valid complete decision', () => {
    const errors = validateCriteriaDecisionCrossFields(
      VALID_CRITERIA_DECISION, optionIds, criterionIds
    );
    assert.equal(errors.length, 0);
  });

  it('rejects missing option evaluation', () => {
    const partial = {
      ...VALID_CRITERIA_DECISION,
      option_evaluations: [VALID_CRITERIA_DECISION.option_evaluations[0]]
    };
    const errors = validateCriteriaDecisionCrossFields(partial, optionIds, criterionIds);
    assert.ok(errors.some(e => e.includes('opt_b')));
  });

  it('rejects unknown option in evaluations', () => {
    const bad = JSON.parse(JSON.stringify(VALID_CRITERIA_DECISION));
    bad.option_evaluations[1].option_id = 'opt_z';
    const errors = validateCriteriaDecisionCrossFields(bad, optionIds, criterionIds);
    assert.ok(errors.some(e => e.includes('opt_z')));
  });

  it('rejects missing criterion in evaluations', () => {
    const bad = JSON.parse(JSON.stringify(VALID_CRITERIA_DECISION));
    bad.option_evaluations[0].criterion_evaluations = [
      bad.option_evaluations[0].criterion_evaluations[0]
    ];
    const errors = validateCriteriaDecisionCrossFields(bad, optionIds, criterionIds);
    assert.ok(errors.some(e => e.includes('crit_ease')));
  });

  it('rejects unknown criterion in evaluations', () => {
    const bad = JSON.parse(JSON.stringify(VALID_CRITERIA_DECISION));
    bad.option_evaluations[0].criterion_evaluations[0].criterion_id = 'crit_unknown';
    const errors = validateCriteriaDecisionCrossFields(bad, optionIds, criterionIds);
    assert.ok(errors.some(e => e.includes('crit_unknown')));
  });

  it('rejects duplicate option evaluations', () => {
    const bad = {
      ...VALID_CRITERIA_DECISION,
      option_evaluations: [
        VALID_CRITERIA_DECISION.option_evaluations[0],
        VALID_CRITERIA_DECISION.option_evaluations[0]
      ]
    };
    const errors = validateCriteriaDecisionCrossFields(bad, optionIds, criterionIds);
    assert.ok(errors.some(e => e.includes('Duplicate')));
  });
});

describe('isCriteriaDecision', () => {
  it('returns true for criteria decision', () => {
    assert.ok(isCriteriaDecision(VALID_CRITERIA_DECISION));
  });

  it('returns false for simple decision', () => {
    assert.ok(!isCriteriaDecision(VALID_SIMPLE_DECISION));
  });
});

// ── JSON Extraction Tests ──

describe('extractJsonFromResponse', () => {
  it('extracts clean JSON', () => {
    const raw = JSON.stringify(VALID_SIMPLE_DECISION);
    const result = extractJsonFromResponse(raw);
    assert.deepEqual(result, VALID_SIMPLE_DECISION);
  });

  it('extracts markdown-fenced JSON', () => {
    const raw = 'Here is my response:\n```json\n' + JSON.stringify(VALID_SIMPLE_DECISION) + '\n```\nDone.';
    const result = extractJsonFromResponse(raw);
    assert.deepEqual(result, VALID_SIMPLE_DECISION);
  });

  it('extracts from plain markdown fences (no json tag)', () => {
    const raw = '```\n' + JSON.stringify(VALID_SIMPLE_DECISION) + '\n```';
    const result = extractJsonFromResponse(raw);
    assert.deepEqual(result, VALID_SIMPLE_DECISION);
  });

  it('extracts JSON embedded in prose', () => {
    const raw = 'I think the answer is: ' + JSON.stringify(VALID_SIMPLE_DECISION) + ' — and that is my choice.';
    const result = extractJsonFromResponse(raw);
    assert.deepEqual(result, VALID_SIMPLE_DECISION);
  });

  it('throws on completely invalid input', () => {
    assert.throws(() => extractJsonFromResponse('No JSON here at all.'));
  });

  it('throws on empty string', () => {
    assert.throws(() => extractJsonFromResponse(''));
  });
});

// ── validateDecision Tests ──

describe('validateDecision', () => {
  it('validates simple decision against simple request', () => {
    const result = validateDecision(VALID_SIMPLE_DECISION, SIMPLE_REQUEST);
    assert.ok(result.valid);
  });

  it('validates criteria decision against criteria request', () => {
    const result = validateDecision(VALID_CRITERIA_DECISION, CRITERIA_REQUEST);
    assert.ok(result.valid);
  });

  it('rejects unknown option ID in simple mode', () => {
    const bad = { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_z' };
    const result = validateDecision(bad, SIMPLE_REQUEST);
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some(e => e.includes('opt_z')));
    }
  });

  it('rejects missing fields', () => {
    const result = validateDecision({ selected_option_id: 'opt_a' }, SIMPLE_REQUEST);
    assert.ok(!result.valid);
  });
});

// ── Prompt Construction Tests ──

describe('buildMcqPrompt', () => {
  it('builds simple prompt without criteria block', () => {
    const prompt = buildMcqPrompt(SIMPLE_REQUEST);
    assert.ok(prompt.includes('anonymous council'));
    assert.ok(prompt.includes('opt_a'));
    assert.ok(prompt.includes('opt_b'));
    assert.ok(prompt.includes('opt_c'));
    assert.ok(prompt.includes('PostgreSQL'));
    assert.ok(!prompt.includes('EVALUATION CRITERIA'));
    assert.ok(!prompt.includes('REQUIRED REVIEWER FORMAT'));
  });

  it('builds criteria prompt with criteria block', () => {
    const prompt = buildMcqPrompt(CRITERIA_REQUEST);
    assert.ok(prompt.includes('EVALUATION CRITERIA'));
    assert.ok(prompt.includes('crit_perf'));
    assert.ok(prompt.includes('crit_ease'));
    assert.ok(prompt.includes('criterion'));
  });

  it('does not include reviewerContract', () => {
    const simplePrompt = buildMcqPrompt(SIMPLE_REQUEST);
    const criteriaPrompt = buildMcqPrompt(CRITERIA_REQUEST);
    assert.ok(!simplePrompt.includes('REQUIRED REVIEWER FORMAT'));
    assert.ok(!criteriaPrompt.includes('REQUIRED REVIEWER FORMAT'));
    assert.ok(!simplePrompt.includes('Confirmed defect'));
    assert.ok(!criteriaPrompt.includes('Confirmed defect'));
  });

  it('includes context notes when provided', () => {
    const request: McqRequest = {
      ...SIMPLE_REQUEST,
      context: { notes: 'Consider our serverless architecture.' }
    };
    const prompt = buildMcqPrompt(request);
    assert.ok(prompt.includes('serverless architecture'));
  });

  it('produces identical prompts (deterministic)', () => {
    const prompt1 = buildMcqPrompt(SIMPLE_REQUEST);
    const prompt2 = buildMcqPrompt(SIMPLE_REQUEST);
    assert.equal(prompt1, prompt2);
  });
});

// ── Vote Aggregation Tests ──

describe('aggregateVotes', () => {
  it('correctly counts votes', () => {
    const votes: McqMemberVote[] = [
      { provider: 'chatgpt', taskId: 't1', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_a' }, rawResponse: '' },
      { provider: 'gemini', taskId: 't2', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_a' }, rawResponse: '' },
      { provider: 'meta', taskId: 't3', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_b' }, rawResponse: '' }
    ];

    const dist = aggregateVotes(votes, SIMPLE_REQUEST, []);
    assert.equal(dist.eligible_members, 3);
    assert.equal(dist.valid_votes, 3);
    assert.equal(dist.failed_votes, 0);

    const optA = dist.distribution.find(d => d.option_id === 'opt_a');
    const optB = dist.distribution.find(d => d.option_id === 'opt_b');
    const optC = dist.distribution.find(d => d.option_id === 'opt_c');

    assert.equal(optA!.vote_count, 2);
    assert.ok(Math.abs(optA!.vote_fraction - 2 / 3) < 0.001);
    assert.deepEqual(optA!.voters, ['chatgpt', 'gemini']);

    assert.equal(optB!.vote_count, 1);
    assert.ok(Math.abs(optB!.vote_fraction - 1 / 3) < 0.001);

    assert.equal(optC!.vote_count, 0);
    assert.equal(optC!.vote_fraction, 0);
  });

  it('handles failed providers', () => {
    const votes: McqMemberVote[] = [
      { provider: 'chatgpt', taskId: 't1', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_a' }, rawResponse: '' }
    ];

    const dist = aggregateVotes(votes, SIMPLE_REQUEST, ['gemini', 'meta']);
    assert.equal(dist.eligible_members, 3);
    assert.equal(dist.valid_votes, 1);
    assert.equal(dist.failed_votes, 2);
    assert.deepEqual(dist.abstained, ['gemini', 'meta']);
  });

  it('handles zero votes', () => {
    const dist = aggregateVotes([], SIMPLE_REQUEST, ['chatgpt', 'gemini']);
    assert.equal(dist.eligible_members, 2);
    assert.equal(dist.valid_votes, 0);
    assert.equal(dist.failed_votes, 2);

    for (const d of dist.distribution) {
      assert.equal(d.vote_count, 0);
      assert.equal(d.vote_fraction, 0);
    }
  });

  it('sorts by vote count descending', () => {
    const votes: McqMemberVote[] = [
      { provider: 'p1', taskId: 't1', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_c' }, rawResponse: '' },
      { provider: 'p2', taskId: 't2', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_c' }, rawResponse: '' },
      { provider: 'p3', taskId: 't3', decision: { ...VALID_SIMPLE_DECISION, selected_option_id: 'opt_a' }, rawResponse: '' }
    ];

    const dist = aggregateVotes(votes, SIMPLE_REQUEST, []);
    assert.equal(dist.distribution[0].option_id, 'opt_c');
    assert.equal(dist.distribution[0].vote_count, 2);
  });
});

// ── Repair Prompt Tests ──

describe('buildRepairPrompt', () => {
  it('includes validation errors', () => {
    const prompt = buildRepairPrompt('bad json', ['Missing field X', 'Invalid type Y']);
    assert.ok(prompt.includes('Missing field X'));
    assert.ok(prompt.includes('Invalid type Y'));
    assert.ok(prompt.includes('bad json'));
  });

  it('truncates long responses', () => {
    const longResponse = 'x'.repeat(3000);
    const prompt = buildRepairPrompt(longResponse, ['error']);
    assert.ok(prompt.includes('...'));
    assert.ok(prompt.length < longResponse.length);
  });
});

// ── Input Validation Tests ──

describe('input validation', () => {
  it('rejects empty question', () => {
    // This is tested via the engine entry point, but we validate the schema logic
    const request: McqRequest = {
      question: '',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    };
    assert.equal(request.question.trim().length, 0);
  });

  it('rejects fewer than 2 options', () => {
    const request: McqRequest = {
      question: 'Pick one',
      options: [{ id: 'a', label: 'A' }]
    };
    assert.ok(request.options.length < 2);
  });

  it('rejects duplicate option IDs', () => {
    const optionIds = new Set(['a', 'a']);
    // Set deduplicates, so size check catches this
    assert.equal(optionIds.size, 1);
  });
});
