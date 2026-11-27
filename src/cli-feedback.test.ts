import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildFeedbackSummaryReport,
  parseFeedbackArgs,
  renderFeedbackSummaryMarkdown,
} from './cli-feedback.js';
import { buildFeedbackEntry, feedbackLedgerPath } from './feedback-ledger.js';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

describe('parseFeedbackArgs', () => {
  it('parses add, list, and promote modes', () => {
    expect(parseFeedbackArgs([
      'add',
      '--kb=ops',
      '--query=rollback',
      '--source=runbooks/deploy.md',
      '--verdict=relevant',
      '--relevance=2',
      '--group=procedure',
      '--format=json',
    ])).toMatchObject({
      action: 'add',
      kb: 'ops',
      query: 'rollback',
      source: 'runbooks/deploy.md',
      verdict: 'relevant',
      relevance: 2,
      groups: ['procedure'],
      format: 'json',
    });

    expect(parseFeedbackArgs(['list', '--kb=ops', '--limit=10'])).toMatchObject({
      action: 'list',
      limit: 10,
    });

    expect(parseFeedbackArgs([
      'promote',
      '--kb=ops',
      '--query=rollback',
      '--fixture=eval.yml',
      '--yes',
      '--gate',
    ])).toMatchObject({
      action: 'promote',
      fixture: 'eval.yml',
      yes: true,
      gate: true,
    });
  });

  it('requires explicit confirmation before promote writes a fixture', () => {
    expect(() => parseFeedbackArgs([
      'promote',
      '--kb=ops',
      '--query=rollback',
      '--fixture=eval.yml',
    ])).toThrow('--fixture=<path> requires --yes');
  });
});

describe('kb feedback summary', () => {
  const line = (
    n: number,
    query: string,
    source: string,
    judgment: { verdict?: 'relevant' | 'irrelevant' | 'stale' | 'misleading'; relevance?: number; groups?: string[] },
  ): string => JSON.stringify(buildFeedbackEntry({
    id: `entry-${n}`,
    now: new Date(`2026-05-19T10:00:0${n}.000Z`),
    kb: 'ops',
    query,
    source,
    ...judgment,
  }));
  // Same hand-computed rows as feedback-ledger.test.ts, plus one torn line.
  const ledgerText = [
    line(1, 'rollback', 'a.md', { verdict: 'relevant', relevance: 3, groups: ['runbook', 'procedure'] }),
    line(2, 'rollback', 'old.md', { verdict: 'stale' }),
    line(3, 'rollback', 'old.md', { verdict: 'misleading' }),
    '{"schema_version":"kb-feedback.v1","id":"torn',
    line(4, 'deploy', 'old.md', { relevance: 1, groups: ['procedure'] }),
    line(5, 'deploy', 'b.md', { relevance: 0 }),
    line(6, 'deploy', 'c.md', { verdict: 'irrelevant' }),
    line(7, 'rollback', 'a.md', { relevance: 2 }),
  ].join('\n') + '\n';

  async function makeKb(withLedger: boolean): Promise<{ kbRoot: string; kbDir: string; ledgerPath: string }> {
    const kbRoot = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-feedback-summary-')), 'kbs');
    const kbDir = path.join(kbRoot, 'ops');
    await fsp.mkdir(kbDir, { recursive: true });
    const ledgerPath = feedbackLedgerPath(kbDir);
    if (withLedger) {
      await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
      await fsp.writeFile(ledgerPath, ledgerText, 'utf-8');
    }
    return { kbRoot, kbDir, ledgerPath };
  }

  function runCli(args: string[], kbRoot: string): { code: number; stdout: string; stderr: string } {
    const result = spawnSync('node', [cliPath, ...args], {
      env: { PATH: process.env.PATH ?? '', KB_LOG_FORMAT: 'text', KNOWLEDGE_BASES_ROOT_DIR: kbRoot },
      encoding: 'utf-8',
    });
    if (result.error) throw result.error;
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it('parses summary flags with a default top and rejects flags of other actions', () => {
    expect(parseFeedbackArgs(['summary', '--kb=ops'])).toEqual({
      action: 'summary', kb: 'ops', format: 'md', top: 10,
    });
    expect(parseFeedbackArgs(['summary', '--kb=ops', '--query=rollback', '--top=3', '--format=json']))
      .toEqual({ action: 'summary', kb: 'ops', format: 'json', query: 'rollback', top: 3 });
    expect(() => parseFeedbackArgs(['summary', '--kb=ops', '--top=0'])).toThrow('invalid --top');
    expect(() => parseFeedbackArgs(['summary', '--kb=ops', '--top=1.5'])).toThrow('invalid --top');
    expect(() => parseFeedbackArgs(['summary', '--kb=ops', '--limit=5'])).toThrow('unknown flag: --limit=5');
    expect(() => parseFeedbackArgs(['list', '--kb=ops', '--top=5'])).toThrow('unknown flag: --top=5');
    expect(() => parseFeedbackArgs(['stats', '--kb=ops'])).toThrow('add, list, promote, or summary');
  });

  it('reports the ledger-wide torn-line count and filters rows by --query', async () => {
    const { kbDir, ledgerPath } = await makeKb(true);
    const report = await buildFeedbackSummaryReport(kbDir, { kb: 'ops', query: 'deploy', top: 10 });
    expect(report).toMatchObject({
      schema_version: 'kb-feedback-summary.v1',
      kb: 'ops',
      ledger_path: ledgerPath,
      query: 'deploy',
      top: 10,
      malformed_line_count: 1,
      total_entries: 3,
      distinct_queries: 1,
      distinct_sources: 3,
      verdict_counts: { relevant: 1, irrelevant: 2, stale: 0, misleading: 0 },
      relevant_share: 0.3333,
      mean_relevance: 0.3333,
      group_counts: [{ group: 'procedure', count: 1 }],
    });
    // old.md only has a relevant row under "deploy", so it is not flagged here.
    expect(report.top_flagged_sources.map((entry) => entry.source)).toEqual(['b.md', 'c.md']);
  });

  it('renders the Markdown summary', async () => {
    const { kbDir, ledgerPath } = await makeKb(true);
    const report = await buildFeedbackSummaryReport(kbDir, { kb: 'ops', top: 2 });
    expect(renderFeedbackSummaryMarkdown(report)).toBe([
      '# kb feedback summary',
      '',
      `Ledger: ${ledgerPath}`,
      '',
      '- Entries: 7 (2 queries, 4 sources)',
      '- Relevant share: 42.9% (3/7)',
      '- Mean relevance: 0.86 (0..3)',
      '- Verdicts: relevant 3, irrelevant 2, stale 1, misleading 1',
      '- Skipped malformed lines: 1',
      '',
      '## Groups',
      '',
      '- procedure: 2',
      '- runbook: 1',
      '',
      '## Most-flagged sources (top 2)',
      '',
      '- old.md: 2 flagged (irrelevant 0, stale 1, misleading 1; relevant 1), last 2026-05-19T10:00:03.000Z',
      '- b.md: 1 flagged (irrelevant 1, stale 0, misleading 0; relevant 0), last 2026-05-19T10:00:05.000Z',
      '',
    ].join('\n'));
  });

  it('prints the summary end to end and leaves the ledger byte-identical', async () => {
    const { kbRoot, ledgerPath } = await makeKb(true);
    const before = await fsp.readFile(ledgerPath);

    const md = runCli(['feedback', 'summary', '--kb=ops'], kbRoot);
    expect(md.code).toBe(0);
    expect(md.stdout).toContain('- Relevant share: 42.9% (3/7)');
    expect(md.stdout).toContain('- old.md: 2 flagged');

    const json = runCli(['feedback', 'summary', '--kb=ops', '--query=rollback', '--top=1', '--format=json'], kbRoot);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      query: 'rollback',
      top: 1,
      total_entries: 4,
      verdict_counts: { relevant: 2, irrelevant: 0, stale: 1, misleading: 1 },
      relevant_share: 0.5,
      mean_relevance: 1.25,
      malformed_line_count: 1,
      top_flagged_sources: [expect.objectContaining({ source: 'old.md', flagged_count: 2 })],
    });

    expect((await fsp.readFile(ledgerPath)).equals(before)).toBe(true);
  });

  it('prints a zero summary for a missing ledger, exits 0 and creates nothing', async () => {
    const { kbRoot, kbDir } = await makeKb(false);
    const json = runCli(['feedback', 'summary', '--kb=ops', '--format=json'], kbRoot);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      total_entries: 0,
      relevant_share: null,
      mean_relevance: null,
      malformed_line_count: 0,
      top_flagged_sources: [],
    });
    const md = runCli(['feedback', 'summary', '--kb=ops'], kbRoot);
    expect(md.code).toBe(0);
    expect(md.stdout).toContain('- Relevant share: n/a');
    expect(md.stdout).toContain('No flagged sources.');
    await expect(fsp.access(path.join(kbDir, '.index'))).rejects.toThrow();
  });

  it('prints a zero summary for an empty ledger file', async () => {
    const { kbDir, ledgerPath } = await makeKb(false);
    await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fsp.writeFile(ledgerPath, '', 'utf-8');
    const report = await buildFeedbackSummaryReport(kbDir, { kb: 'ops', top: 10 });
    expect(report).toMatchObject({ total_entries: 0, relevant_share: null, malformed_line_count: 0 });
  });
});
