import { describe, expect, it } from '@jest/globals';
import {
  buildRecommendKbPayload,
  decideWhere,
  toWhereJsonShape,
  type WhereDecision,
} from './recommend-kb-core.js';
import type { ScoredDocument } from './formatter.js';

function doc(kb: string | null, rel: string | null, score: number): ScoredDocument {
  const metadata: Record<string, unknown> = {};
  if (kb !== null) metadata.knowledgeBase = kb;
  if (rel !== null) metadata.relativePath = rel;
  return { pageContent: 'x', metadata, score };
}

describe('buildRecommendKbPayload (kb.recommend.v1)', () => {
  it('serializes a high-confidence decision: recommended KB, best file, score, confident=true', () => {
    const decision = decideWhere(
      [
        doc('alpha', 'a/file-a.md', 0.85),
        doc('beta', 'b/file-b.md', 0.40),
      ],
      1.0,
    );
    const payload = buildRecommendKbPayload(decision);
    expect(payload).toEqual({
      schema_version: 'kb.recommend.v1',
      recommended_kb: 'beta',
      existing_target: 'b/file-b.md',
      confidence: 0.4,
      confident: true,
    });
  });

  it('serializes a low-confidence decision: existing_target=null and confident=false when the best score is above threshold', () => {
    // Best file score 1.40 is above the 1.0 confidence threshold → decideWhere
    // withholds the existing target and reports the KB-level score instead.
    const decision = decideWhere(
      [
        doc('alpha', 'a/loose.md', 1.4),
        doc('beta', 'b/loose.md', 1.55),
      ],
      1.0,
    );
    const payload = buildRecommendKbPayload(decision);
    expect(payload.schema_version).toBe('kb.recommend.v1');
    expect(payload.recommended_kb).toBe('alpha');
    expect(payload.existing_target).toBeNull();
    expect(payload.confidence).toBeCloseTo(1.4, 6);
    expect(payload.confident).toBe(false);
  });

  it('serializes a null decision (no similar notes) to an all-null, not-confident recommendation', () => {
    const payload = buildRecommendKbPayload(null);
    expect(payload).toEqual({
      schema_version: 'kb.recommend.v1',
      recommended_kb: null,
      existing_target: null,
      confidence: null,
      confident: false,
    });
  });

  it('honours the confidence threshold exactly as the CLI does (same decideWhere input → same confident flag)', () => {
    const results = [doc('alpha', 'a/x.md', 0.8)];
    // Threshold 0.5: 0.8 is above → not confident, no existing target.
    expect(buildRecommendKbPayload(decideWhere(results, 0.5))).toMatchObject({
      existing_target: null,
      confident: false,
    });
    // Threshold 1.0: 0.8 is below → confident, existing target surfaced.
    expect(buildRecommendKbPayload(decideWhere(results, 1.0))).toMatchObject({
      existing_target: 'a/x.md',
      confident: true,
    });
  });

  it('drops the CLI-only suggested_invocation that the `kb where --format=json` shape carries', () => {
    const decision: WhereDecision = {
      recommendedKb: 'alpha',
      existingTarget: 'a/x.md',
      confidence: 0.2,
      suggestedInvocation: 'kb remember --kb=alpha --append=a/x.md --stdin --yes',
    };
    // The CLI JSON shape keeps the copy-paste; the MCP payload must not.
    expect(toWhereJsonShape(decision)).toHaveProperty('suggested_invocation');
    const payload = buildRecommendKbPayload(decision);
    expect(payload).not.toHaveProperty('suggested_invocation');
    // Every retained field matches the CLI shape so the two surfaces agree.
    expect(payload.recommended_kb).toBe('alpha');
    expect(payload.existing_target).toBe('a/x.md');
    expect(payload.confidence).toBe(0.2);
    expect(payload.confident).toBe(true);
  });
});
