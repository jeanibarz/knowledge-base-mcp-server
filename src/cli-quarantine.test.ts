import { describe, expect, it, jest } from '@jest/globals';
import type { IngestQuarantineRecord } from './ingest-quarantine.js';
import {
  formatQuarantineMarkdown,
  parseQuarantineArgs,
  runQuarantine,
  type RunQuarantineDeps,
} from './cli-quarantine.js';

function record(relativePath: string, retryCount = 1): IngestQuarantineRecord {
  return {
    schema_version: 'ingest-quarantine.v1',
    relative_path: relativePath,
    source_sha256: 'hash',
    error_category: 'input',
    error_code: 'EINVAL',
    error_fingerprint: 'sha256:' + 'a'.repeat(64),
    first_seen_at: '2026-05-12T10:00:00.000Z',
    last_attempted_at: '2026-05-12T10:00:00.000Z',
    retry_count: retryCount,
    next_retry_at: '2026-05-12T10:02:00.000Z',
    ack: false,
    dead_lettered_at: null,
    message: 'bad input',
  };
}

function secretRecord(relativePath: string): IngestQuarantineRecord {
  return {
    ...record(relativePath),
    reason: 'secret_detected',
    error_code: 'secret_detected',
  };
}

function makeDeps(recordsByKb: Record<string, IngestQuarantineRecord[]>): {
  deps: RunQuarantineDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: RunQuarantineDeps = {
    listKnowledgeBases: jest.fn(async () => Object.keys(recordsByKb)),
    listIngestQuarantine: jest.fn(async (kbPath: string) => {
      const kb = kbPath.split('/').pop() ?? '';
      return recordsByKb[kb] ?? [];
    }),
    removeIngestQuarantineEntry: jest.fn(async () => true),
    clearIngestQuarantine: jest.fn(async () => 2),
    forceRetryIngestQuarantineEntry: jest.fn(async () => record('bad.md')),
    ackIngestQuarantineEntry: jest.fn(async () => ({ ...record('bad.md'), ack: true })),
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  };
  return { deps, stdout, stderr };
}

describe('kb quarantine CLI', () => {
  it('parses supported actions and rejects invalid flag combinations', () => {
    expect(parseQuarantineArgs(['list', '--kb=alpha', '--format=json'])).toEqual({
      action: 'list',
      kb: 'alpha',
      all: false,
      format: 'json',
    });
    expect(parseQuarantineArgs(['list', '--reason=secret_detected'])).toMatchObject({
      action: 'list',
      reason: 'secret_detected',
    });
    expect(parseQuarantineArgs(['clear', '--kb=alpha', '--path=bad.md'])).toMatchObject({
      action: 'clear',
      kb: 'alpha',
      path: 'bad.md',
    });
    expect(() => parseQuarantineArgs([])).toThrow(/missing action/);
    expect(() => parseQuarantineArgs(['retry', '--all'])).toThrow(/--all is only supported/);
    expect(() => parseQuarantineArgs(['ack', '--format=json'])).toThrow(/--format is only supported/);
    expect(() => parseQuarantineArgs(['clear', '--reason=secret_detected'])).toThrow(/--reason is only supported/);
  });

  it('lists quarantined entries across KBs as JSON', async () => {
    const { deps, stdout, stderr } = makeDeps({
      beta: [record('b.md', 2)],
      alpha: [record('a.md')],
    });

    const code = await runQuarantine(['list', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const parsed = JSON.parse(stdout.join('')) as { entries: Array<{ kb: string; relative_path: string }> };
    expect(parsed.entries.map((entry) => `${entry.kb}/${entry.relative_path}`))
      .toEqual(['alpha/a.md', 'beta/b.md']);
  });

  it('formats markdown list output for operator inspection', () => {
    expect(formatQuarantineMarkdown([{ kb: 'alpha', ...record('bad|name.md') }]))
      .toContain('| alpha | bad\\|name.md |  | input | EINVAL | 1 | 2026-05-12T10:02:00.000Z | no |');
    expect(formatQuarantineMarkdown([])).toBe('No quarantined ingest files.\n');
  });

  it('filters list output by quarantine reason', async () => {
    const { deps, stdout } = makeDeps({
      alpha: [record('bad.md'), secretRecord('leak.md')],
    });

    const code = await runQuarantine(['list', '--kb=alpha', '--reason=secret_detected', '--format=json'], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as { entries: Array<{ relative_path: string; reason?: string }> };
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        relative_path: 'leak.md',
        reason: 'secret_detected',
      }),
    ]);
  });

  it('runs clear, retry, and ack mutations with --kb and --path', async () => {
    const { deps, stdout } = makeDeps({ alpha: [record('bad.md')] });

    await expect(runQuarantine(['clear', '--kb=alpha', '--path=bad.md'], deps)).resolves.toBe(0);
    await expect(runQuarantine(['retry', '--kb=alpha', '--path=bad.md'], deps)).resolves.toBe(0);
    await expect(runQuarantine(['ack', '--kb=alpha', '--path=bad.md'], deps)).resolves.toBe(0);

    expect(deps.removeIngestQuarantineEntry).toHaveBeenCalledWith(expect.stringMatching(/alpha$/), 'bad.md');
    expect(deps.forceRetryIngestQuarantineEntry).toHaveBeenCalledWith(expect.stringMatching(/alpha$/), 'bad.md');
    expect(deps.ackIngestQuarantineEntry).toHaveBeenCalledWith(expect.stringMatching(/alpha$/), 'bad.md');
    expect(stdout.join('')).toContain('Cleared alpha/bad.md.');
    expect(stdout.join('')).toContain('Retry scheduled for alpha/bad.md.');
    expect(stdout.join('')).toContain('Acked alpha/bad.md');
  });

  it('returns exit 2 for argv errors and exit 1 when an entry is missing', async () => {
    const { deps, stderr } = makeDeps({ alpha: [] });
    deps.removeIngestQuarantineEntry = jest.fn(async () => false);

    await expect(runQuarantine(['clear', '--kb=alpha'], deps)).resolves.toBe(1);
    await expect(runQuarantine(['wat'], deps)).resolves.toBe(2);
    expect(stderr.join('')).toContain('--path is required');
    expect(stderr.join('')).toContain('unknown action: wat');
  });
});
