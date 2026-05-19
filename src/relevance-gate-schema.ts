import { z } from 'zod';

export const RELEVANCE_GATE_SCHEMA_VERSION = 'kb.relevance-gate.v1';

export const relevanceGateVerdictSchema = z.object({
  schema_version: z.literal(RELEVANCE_GATE_SCHEMA_VERSION),
  state: z.enum(['bypassed', 'empty-index', 'injected', 'no-relevant-context']),
  low_confidence: z.boolean(),
  input_count: z.number().int().nonnegative(),
  output_count: z.number().int().nonnegative(),
  dropped: z.array(z.object({
    id: z.string(),
    stage: z.string(),
    reason: z.string(),
  })),
  judge: z.object({
    status: z.enum(['not-run', 'skipped', 'succeeded', 'failed']),
    reason: z.string().optional(),
    model: z.string().nullable().optional(),
  }),
  empty_verdict_enabled: z.boolean(),
});

export type RelevanceGateVerdict = z.infer<typeof relevanceGateVerdictSchema>;

export const relevanceGateJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://jeanibarz.github.io/knowledge-base-mcp-server/schemas/relevance-gate.v1.json',
  title: 'KB relevance gate verdict',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'state',
    'low_confidence',
    'input_count',
    'output_count',
    'dropped',
    'judge',
    'empty_verdict_enabled',
  ],
  properties: {
    schema_version: { const: RELEVANCE_GATE_SCHEMA_VERSION },
    state: {
      type: 'string',
      enum: ['bypassed', 'empty-index', 'injected', 'no-relevant-context'],
    },
    low_confidence: { type: 'boolean' },
    input_count: { type: 'integer', minimum: 0 },
    output_count: { type: 'integer', minimum: 0 },
    dropped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'stage', 'reason'],
        properties: {
          id: { type: 'string' },
          stage: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    judge: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: ['not-run', 'skipped', 'succeeded', 'failed'],
        },
        reason: { type: 'string' },
        model: { type: ['string', 'null'] },
      },
    },
    empty_verdict_enabled: { type: 'boolean' },
  },
} as const;

export function assertRelevanceGateVerdict(value: unknown): RelevanceGateVerdict {
  return relevanceGateVerdictSchema.parse(value);
}
