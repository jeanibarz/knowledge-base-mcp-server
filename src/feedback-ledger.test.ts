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

  it('rejects invalid JSONL rows with line numbers', () => {
    expect(() => parseFeedbackJsonl('{"schema_version":"wrong"}\n'))
      .toThrow('feedback ledger line 1');
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
