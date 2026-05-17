import { describe, expect, it } from '@jest/globals';
import {
  assertRelevanceGateVerdict,
  relevanceGateJsonSchema,
} from './relevance-gate-schema.js';

describe('relevance gate schema artifact', () => {
  it('validates a server gate verdict shape', () => {
    const verdict = assertRelevanceGateVerdict({
      schema_version: 'kb.relevance-gate.v1',
      state: 'injected',
      low_confidence: false,
      input_count: 1,
      output_count: 1,
      dropped: [],
      judge: { status: 'skipped', reason: 'task_context absent or too short' },
      empty_verdict_enabled: false,
    });

    expect(verdict.state).toBe('injected');
    expect(relevanceGateJsonSchema.properties).toHaveProperty('state');
    expect(relevanceGateJsonSchema.properties).toHaveProperty('judge');
  });
});
