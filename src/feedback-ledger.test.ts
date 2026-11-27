import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  appendFeedbackEntry,
  appendPromotedCaseToFixtureFile,
  buildFeedbackEntry,
  buildPromotedEvalFixture,
  FEEDBACK_LEDGER_SCHEMA_VERSION,
  feedbackLedgerPath,
  parseFeedbackJsonl,
  readFeedbackLedger,
  readFeedbackLedgerWithStats,
  summarizeFeedbackEntries,
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

describe('summarizeFeedbackEntries', () => {
  // Hand-computed fixture (issue #1312). Two queries; old.md is judged under
  // both and carries relevant + non-relevant rows; b.md and c.md tie on one
  // flag each; rows 4 and 5 are graded-only
  // (relevance 1 -> relevant, relevance 0 -> irrelevant).
  const row = (
    n: number,
    query: string,
    source: string,
    judgment: { verdict?: 'relevant' | 'irrelevant' | 'stale' | 'misleading'; relevance?: number; groups?: string[] },
  ) => buildFeedbackEntry({
    id: `entry-${n}`,
    now: new Date(`2026-05-19T10:00:0${n}.000Z`),
    kb: 'ops',
    query,
    source,
    ...judgment,
  });
  const fixture = [
    row(1, 'rollback', 'a.md', { verdict: 'relevant', relevance: 3, groups: ['runbook', 'procedure'] }),
    row(2, 'rollback', 'old.md', { verdict: 'stale' }),
    row(3, 'rollback', 'old.md', { verdict: 'misleading' }),
    row(4, 'deploy', 'old.md', { relevance: 1, groups: ['procedure'] }),
    row(5, 'deploy', 'b.md', { relevance: 0 }),
    row(6, 'deploy', 'c.md', { verdict: 'irrelevant' }),
    row(7, 'rollback', 'a.md', { relevance: 2 }),
  ];

  it('matches the hand-computed counts, share, mean, groups and flagged ranking', () => {
    expect(summarizeFeedbackEntries(fixture)).toEqual({
      total_entries: 7,
      distinct_queries: 2,
      distinct_sources: 4,
      verdict_counts: { relevant: 3, irrelevant: 2, stale: 1, misleading: 1 },
      relevant_share: 0.4286, // 3 / 7
      mean_relevance: 0.8571, // (3 + 0 + 0 + 1 + 0 + 0 + 2) / 7
      group_counts: [
        { group: 'procedure', count: 2 },
        { group: 'runbook', count: 1 },
      ],
      top_flagged_sources: [
        {
          source: 'old.md',
          flagged_count: 2,
          verdict_counts: { relevant: 1, irrelevant: 0, stale: 1, misleading: 1 },
          last_flagged_at: '2026-05-19T10:00:03.000Z',
        },
        {
          source: 'b.md',
          flagged_count: 1,
          verdict_counts: { relevant: 0, irrelevant: 1, stale: 0, misleading: 0 },
          last_flagged_at: '2026-05-19T10:00:05.000Z',
        },
        {
          source: 'c.md',
          flagged_count: 1,
          verdict_counts: { relevant: 0, irrelevant: 1, stale: 0, misleading: 0 },
          last_flagged_at: '2026-05-19T10:00:06.000Z',
        },
      ],
    });
  });

  it('ranks flagged sources by count, then source, independent of row order', () => {
    // m.md is flagged most but inserted last; z.md precedes y.md on a tie; m.md's
    // flags arrive out of date order; the two group labels tie in reverse order.
    const summary = summarizeFeedbackEntries([
      row(3, 'q', 'z.md', { verdict: 'irrelevant', groups: ['zeta'] }),
      row(2, 'q', 'y.md', { verdict: 'irrelevant', groups: ['alpha'] }),
      row(4, 'q', 'm.md', { verdict: 'stale' }),
      row(6, 'q', 'm.md', { verdict: 'irrelevant' }),
      row(1, 'q', 'm.md', { verdict: 'misleading' }),
    ]);
    expect(summary.top_flagged_sources.map((entry) => [entry.source, entry.flagged_count, entry.last_flagged_at]))
      .toEqual([
        ['m.md', 3, '2026-05-19T10:00:06.000Z'],
        ['y.md', 1, '2026-05-19T10:00:02.000Z'],
        ['z.md', 1, '2026-05-19T10:00:03.000Z'],
      ]);
    expect(summary.group_counts).toEqual([
      { group: 'alpha', count: 1 },
      { group: 'zeta', count: 1 },
    ]);
  });

  it('sorts group labels by count before label', () => {
    const summary = summarizeFeedbackEntries([
      row(1, 'q', 'x.md', { groups: ['alpha'] }),
      row(2, 'q', 'x.md', { groups: ['zeta'] }),
      row(3, 'q', 'x.md', { groups: ['zeta'] }),
    ]);
    expect(summary.group_counts).toEqual([
      { group: 'zeta', count: 2 },
      { group: 'alpha', count: 1 },
    ]);
  });

  it('truncates flagged sources to top and keeps the ranking', () => {
    const summary = summarizeFeedbackEntries(fixture, { top: 2 });
    expect(summary.top_flagged_sources.map((entry) => entry.source)).toEqual(['old.md', 'b.md']);
    expect(summary.total_entries).toBe(7);
  });

  it('counts by stored verdict, so a relevant row graded 0 still counts as relevant', () => {
    const summary = summarizeFeedbackEntries([row(1, 'q', 'x.md', { verdict: 'relevant', relevance: 0 })]);
    expect(summary.relevant_share).toBe(1);
    expect(summary.mean_relevance).toBe(0);
    expect(summary.top_flagged_sources).toEqual([]);
  });

  it('returns a zero summary with null share and mean for no rows', () => {
    expect(summarizeFeedbackEntries([])).toEqual({
      total_entries: 0,
      distinct_queries: 0,
      distinct_sources: 0,
      verdict_counts: { relevant: 0, irrelevant: 0, stale: 0, misleading: 0 },
      relevant_share: null,
      mean_relevance: null,
      group_counts: [],
      top_flagged_sources: [],
    });
  });
});

describe('feedback ledger docs', () => {
  // Guards the documented entry shape against drift (issue #1323): the docs once
  // claimed ULID ids, a `task_context_sha256` field and a `relevance-feedback.v1`
  // schema, none of which the code ever produced.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const fullEntry = buildFeedbackEntry({
    kb: 'work',
    query: 'rollback procedure',
    source: 'runbooks/deploy.md',
    chunkId: 'work/runbooks/deploy.md#L42-L78',
    verdict: 'relevant',
    relevance: 3,
    taskContext: 'incident-123',
    note: 'matches step 3 in deploy.md',
    groups: ['runbook'],
  });

  function expectDocumentedEntryMatchesCode(documented: Record<string, unknown>): void {
    expect(Object.keys(documented).sort()).toEqual(Object.keys(fullEntry).sort());
    expect(documented.schema_version).toBe(FEEDBACK_LEDGER_SCHEMA_VERSION);
    expect(documented.id).toMatch(UUID_RE);
  }

  it('generates random UUID ids', () => {
    expect(fullEntry.id).toMatch(UUID_RE);
  });

  it('documents the kb feedback add entry in cli-json-contracts.md with the real field names', async () => {
    const markdown = await fsp.readFile(path.join(process.cwd(), 'docs', 'cli-json-contracts.md'), 'utf-8');
    const section = markdown.split('## `kb feedback`')[1]?.split(/^## `/m)[0] ?? '';
    const addEnvelope = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]) as Record<string, unknown>)
      .find((example) => 'entry' in example);
    expect(addEnvelope).toBeDefined();
    expectDocumentedEntryMatchesCode(addEnvelope!.entry as Record<string, unknown>);
  });

  it('documents the stored ledger row in feedback-workflow.md with the real field names', async () => {
    const markdown = await fsp.readFile(path.join(process.cwd(), 'docs', 'operations', 'feedback-workflow.md'), 'utf-8');
    const block = markdown.split('## What the ledger stores')[1]?.match(/```jsonc\n([\s\S]*?)\n```/)?.[1];
    expect(block).toBeDefined();
    const withoutComments = block!.replace(/\s+\/\/.*$/gm, '');
    expectDocumentedEntryMatchesCode(JSON.parse(withoutComments) as Record<string, unknown>);
  });
});
