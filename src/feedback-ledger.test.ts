import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  appendFeedbackEntry,
  appendPromotedCaseToFixtureFile,
  buildFeedbackEntry,
  buildPromotedEvalFixture,
  feedbackLedgerPath,
  parseFeedbackJsonl,
  readFeedbackLedger,
  readFeedbackLedgerWithStats,
} from './feedback-ledger.js';
import { normalizeRetrievalEvalFixture } from './retrieval-eval.js';

describe('feedback ledger entries', () => {
  it('builds stable JSONL records with hashed task context and default relevant verdict', () => {
    const entry = buildFeedbackEntry({
      id: 'entry-1',
      now: new Date('2026-05-19T10:00:00.000Z'),
      kb: 'ops',
      query: 'rollback procedure',
      source: 'runbooks/deploy.md',
      taskContext: 'incident-123',
      groups: ['procedure', 'procedure'],
    });

    expect(entry).toMatchObject({
      schema_version: 'kb-feedback.v1',
      id: 'entry-1',
      created_at: '2026-05-19T10:00:00.000Z',
      kb: 'ops',
      query: 'rollback procedure',
      source: 'runbooks/deploy.md',
      verdict: 'relevant',
      relevance: 3,
      groups: ['procedure'],
    });
    expect(entry.task_context_hash).toHaveLength(64);
    expect(entry.task_context_hash).not.toBe('incident-123');
  });

  it('round-trips appended entries from a per-KB .index ledger', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-feedback-'));
    const kbDir = path.join(dir, 'ops');
    await fsp.mkdir(kbDir, { recursive: true });

    await appendFeedbackEntry(kbDir, {
      id: 'entry-1',
      now: new Date('2026-05-19T10:00:00.000Z'),
      kb: 'ops',
      query: 'rollback procedure',
      source: 'runbooks/deploy.md',
    });

    expect(feedbackLedgerPath(kbDir)).toBe(path.join(kbDir, '.index', 'relevance-feedback.jsonl'));
    await expect(readFeedbackLedger(kbDir)).resolves.toMatchObject([
      { id: 'entry-1', query: 'rollback procedure', source: 'runbooks/deploy.md' },
    ]);
  });

  it('rejects well-formed JSON rows with an invalid schema, citing line numbers', () => {
    expect(() => parseFeedbackJsonl('{"schema_version":"wrong"}\n'))
      .toThrow('feedback ledger line 1');
  });
});

describe('corruption-tolerant feedback ledger reads', () => {
  const validLine = (id: string): string => JSON.stringify(buildFeedbackEntry({
    id,
    now: new Date('2026-05-19T10:00:00.000Z'),
    kb: 'ops',
    query: 'rollback procedure',
    source: `runbooks/${id}.md`,
  }));

  it('parses a clean ledger with no malformed lines', () => {
    const raw = `${validLine('entry-1')}\n${validLine('entry-2')}\n`;
    const result = parseFeedbackJsonl(raw);
    expect(result.malformedLineCount).toBe(0);
    expect(result.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-2']);
  });

  it('skips and counts a torn final line instead of throwing', () => {
    // A crash mid-append leaves a truncated last line with no trailing newline.
    const raw = `${validLine('entry-1')}\n${validLine('entry-2')}\n{"schema_version":"kb-feed`;
    const result = parseFeedbackJsonl(raw);
    expect(result.malformedLineCount).toBe(1);
    expect(result.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-2']);
  });

  it('skips and counts multiple interior malformed lines, keeping good entries', () => {
    const raw = [
      validLine('entry-1'),
      'this is not json at all',
      validLine('entry-2'),
      '{"truncated": ',
      validLine('entry-3'),
      '', // blank lines are ignored, not counted as malformed
    ].join('\n');
    const result = parseFeedbackJsonl(raw);
    expect(result.malformedLineCount).toBe(2);
    expect(result.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-2', 'entry-3']);
  });

  it('surfaces good entries and the malformed count from readFeedbackLedgerWithStats', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-feedback-torn-'));
    const kbDir = path.join(dir, 'ops');
    await fsp.mkdir(kbDir, { recursive: true });

    await appendFeedbackEntry(kbDir, {
      id: 'entry-1',
      now: new Date('2026-05-19T10:00:00.000Z'),
      kb: 'ops',
      query: 'rollback procedure',
      source: 'runbooks/deploy.md',
    });
    // Simulate a torn write appended after the valid entry.
    await fsp.appendFile(feedbackLedgerPath(kbDir), '{"schema_version":"kb-feed', 'utf-8');

    const stats = await readFeedbackLedgerWithStats(kbDir);
    expect(stats.malformedLineCount).toBe(1);
    expect(stats.entries.map((entry) => entry.id)).toEqual(['entry-1']);

    // The array-returning reader stays corruption-tolerant for existing callers.
    await expect(readFeedbackLedger(kbDir)).resolves.toMatchObject([{ id: 'entry-1' }]);
  });

  it('reports zero malformed lines for a missing ledger', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-feedback-missing-'));
    const stats = await readFeedbackLedgerWithStats(path.join(dir, 'ops'));
    expect(stats).toEqual({ entries: [], malformedLineCount: 0 });
  });
});

describe('feedback promotion', () => {
  it('promotes positive and negative judgments into a valid retrieval-eval fixture', () => {
    const fixture = buildPromotedEvalFixture([
      buildFeedbackEntry({
        id: 'relevant-1',
        now: new Date('2026-05-19T10:00:00.000Z'),
        kb: 'ops',
        query: 'rollback procedure',
        source: 'runbooks/deploy.md',
        relevance: 2,
        groups: ['procedure'],
      }),
      buildFeedbackEntry({
        id: 'stale-1',
        now: new Date('2026-05-19T10:01:00.000Z'),
        kb: 'ops',
        query: 'rollback procedure',
        source: 'archive/old-deploy.md',
        verdict: 'stale',
      }),
    ], {
      kb: 'ops',
      query: 'rollback procedure',
      name: 'rollback feedback',
      k: 5,
      mode: 'hybrid',
      gate: true,
    });

    const normalized = normalizeRetrievalEvalFixture(fixture);
    expect(normalized.cases[0]).toMatchObject({
      name: 'rollback feedback',
      query: 'rollback procedure',
      kb: 'ops',
      k: 5,
      mode: 'hybrid',
      gate: true,
      requiredSources: ['runbooks/deploy.md'],
      forbiddenSources: ['archive/old-deploy.md'],
      relevanceJudgments: [
        { source: 'runbooks/deploy.md', relevance: 2, groups: ['procedure'] },
      ],
      stalePolicy: 'allow_stale',
    });
  });

  it('appends promoted cases to an existing fixture file', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-feedback-fixture-'));
    const fixturePath = path.join(dir, 'fixture.yml');
    await fsp.writeFile(fixturePath, 'gate: false\nmode: hybrid\ncases:\n  - query: existing\n', 'utf-8');
    const promoted = buildPromotedEvalFixture([
      buildFeedbackEntry({
        id: 'entry-1',
        kb: 'ops',
        query: 'rollback procedure',
        source: 'runbooks/deploy.md',
      }),
    ], { kb: 'ops', query: 'rollback procedure' });

    const result = await appendPromotedCaseToFixtureFile(fixturePath, promoted);
    const parsed = normalizeRetrievalEvalFixture(yaml.load(await fsp.readFile(fixturePath, 'utf-8')));

    expect(result).toEqual({ caseCount: 2, created: false });
    expect(parsed.mode).toBe('hybrid');
    expect(parsed.cases.map((c) => c.query)).toEqual(['existing', 'rollback procedure']);
  });
});
