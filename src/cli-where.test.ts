import { describe, expect, it } from '@jest/globals';
import {
  decideWhere,
  formatWhereMarkdown,
  parseWhereArgs,
} from './cli-where.js';
import type { ScoredDocument } from './formatter.js';

function doc(kb: string | null, rel: string | null, score: number): ScoredDocument {
  const metadata: Record<string, unknown> = {};
  if (kb !== null) metadata.knowledgeBase = kb;
  if (rel !== null) metadata.relativePath = rel;
  return { pageContent: 'x', metadata, score };
}

describe('parseWhereArgs', () => {
  it('parses --topic and applies defaults', () => {
    const a = parseWhereArgs(['--topic=kookr state-file schema']);
    expect(a.topic).toBe('kookr state-file schema');
    expect(a.threshold).toBe(1.0);
    expect(a.k).toBe(20);
    expect(a.format).toBe('md');
  });

  it('parses --threshold, --k, --format, --model', () => {
    const a = parseWhereArgs([
      '--topic=t',
      '--threshold=0.7',
      '--k=5',
      '--format=json',
      '--model=hf/some-model',
    ]);
    expect(a.threshold).toBeCloseTo(0.7, 6);
    expect(a.k).toBe(5);
    expect(a.format).toBe('json');
    expect(a.model).toBe('hf/some-model');
  });

  it('rejects empty --topic', () => {
    expect(() => parseWhereArgs(['--topic='])).toThrow(/--topic.*non-empty/);
  });

  it('rejects unknown flags and positional arguments', () => {
    expect(() => parseWhereArgs(['--topic=t', '--bogus'])).toThrow(/unknown flag/);
    expect(() => parseWhereArgs(['--topic=t', 'positional'])).toThrow(/unexpected argument/);
  });

  it('rejects invalid --threshold and --k', () => {
    expect(() => parseWhereArgs(['--threshold=abc'])).toThrow(/invalid --threshold/);
    expect(() => parseWhereArgs(['--threshold=0'])).toThrow(/invalid --threshold/);
    expect(() => parseWhereArgs(['--k=0'])).toThrow(/invalid --k/);
    expect(() => parseWhereArgs(['--k=2.5'])).toThrow(/invalid --k/);
  });

  it('rejects invalid --format', () => {
    expect(() => parseWhereArgs(['--format=yaml'])).toThrow(/invalid --format/);
  });
});

describe('decideWhere', () => {
  it('returns null on empty results', () => {
    expect(decideWhere([])).toBeNull();
  });

  it('picks the KB whose top hit has the lowest score', () => {
    const results = [
      doc('alpha', 'a/file-a.md', 0.85),
      doc('beta', 'b/file-b.md', 0.40),
      doc('alpha', 'a/file-c.md', 0.92),
    ];
    const d = decideWhere(results);
    expect(d).not.toBeNull();
    expect(d!.recommendedKb).toBe('beta');
    expect(d!.existingTarget).toBe('b/file-b.md');
    expect(d!.confidence).toBeCloseTo(0.40, 6);
    expect(d!.suggestedInvocation).toContain('--kb=beta');
    expect(d!.suggestedInvocation).toContain('--append=b/file-b.md');
  });

  it('within the chosen KB, picks the lowest-score file', () => {
    const results = [
      doc('alpha', 'a/older.md', 0.30),
      doc('alpha', 'a/closer.md', 0.20),
      doc('alpha', 'a/farther.md', 0.55),
    ];
    const d = decideWhere(results);
    expect(d!.recommendedKb).toBe('alpha');
    expect(d!.existingTarget).toBe('a/closer.md');
  });

  it('suggests creating a new note when best score is above the threshold', () => {
    const results = [
      doc('alpha', 'a/loose.md', 1.40),
      doc('beta', 'b/loose.md', 1.55),
    ];
    const d = decideWhere(results, 1.0);
    expect(d!.recommendedKb).toBe('alpha');
    expect(d!.existingTarget).toBeNull();
    expect(d!.suggestedInvocation).toContain('--title=<title>');
    expect(d!.suggestedInvocation).not.toContain('--append=');
  });

  it('honours a custom confidence threshold', () => {
    const results = [doc('alpha', 'a/x.md', 0.80)];
    expect(decideWhere(results, 0.5)!.existingTarget).toBeNull();
    expect(decideWhere(results, 1.0)!.existingTarget).toBe('a/x.md');
  });

  it('skips results with no knowledgeBase metadata when picking the KB', () => {
    const results = [
      doc(null, null, 0.10),
      doc('beta', 'b/note.md', 0.50),
    ];
    const d = decideWhere(results);
    expect(d!.recommendedKb).toBe('beta');
  });

  it('falls back to create-new when the chosen KB has no relativePath hits', () => {
    // Simulates a KB whose only hit has knowledgeBase set but relativePath
    // missing (e.g., a chunk created by an older indexing run).
    const results = [doc('alpha', null, 0.20)];
    const d = decideWhere(results);
    expect(d!.recommendedKb).toBe('alpha');
    expect(d!.existingTarget).toBeNull();
    expect(d!.suggestedInvocation).toContain('--title=<title>');
  });
});

describe('formatWhereMarkdown', () => {
  it('renders an existing-target recommendation', () => {
    const out = formatWhereMarkdown({
      recommendedKb: 'beta',
      existingTarget: 'b/file-b.md',
      confidence: 0.71,
      suggestedInvocation: 'kb remember --kb=beta --append=b/file-b.md --stdin --yes',
    });
    expect(out).toContain('Recommended KB:        beta');
    expect(out).toContain('Existing target:       b/file-b.md');
    expect(out).toContain('Confidence:            0.71');
    expect(out).toContain('high; lower distance = closer match');
  });

  it('renders a create-new recommendation when no existing target', () => {
    const out = formatWhereMarkdown({
      recommendedKb: 'alpha',
      existingTarget: null,
      confidence: 1.42,
      suggestedInvocation: 'kb remember --kb=alpha --title=<title> --stdin --yes',
    });
    expect(out).toContain('Existing target:       _(none');
    expect(out).toContain('low; lower distance = closer match');
    expect(out).toContain('--title=<title>');
  });
});
