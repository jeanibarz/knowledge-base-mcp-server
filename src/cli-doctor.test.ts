import { describe, expect, it } from '@jest/globals';
import {
  formatReportMarkdown,
  parseDoctorArgs,
  type DoctorReport,
} from './cli-doctor.js';

function baseReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    version: '0.0.0-test',
    active_model: {
      model_id: 'huggingface__BAAI-bge-small-en-v1.5',
      provider: 'huggingface',
      model_name: 'BAAI/bge-small-en-v1.5',
    },
    active_index: { path: '/tmp/kb/.faiss/models/x/index.v3/faiss.index', mtime: '2026-05-08T00:00:00.000Z' },
    knowledge_bases: [
      { name: 'alpha', total_files: 5, modified_files: 0, new_files: 1 },
      { name: 'beta',  total_files: 3, modified_files: 2, new_files: 0 },
    ],
    checkout: { linked: false, realpath: '/usr/local/bin/kb', worktree: null },
    healthy: true,
    ...overrides,
  };
}

describe('parseDoctorArgs', () => {
  it('defaults format to md', () => {
    expect(parseDoctorArgs([])).toEqual({ format: 'md' });
  });

  it('accepts --format=md and --format=json', () => {
    expect(parseDoctorArgs(['--format=md'])).toEqual({ format: 'md' });
    expect(parseDoctorArgs(['--format=json'])).toEqual({ format: 'json' });
  });

  it('rejects an unsupported --format value', () => {
    expect(() => parseDoctorArgs(['--format=xml'])).toThrow(/invalid --format value/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseDoctorArgs(['--bogus'])).toThrow(/unknown flag/);
  });

  it('rejects positional arguments', () => {
    expect(() => parseDoctorArgs(['lol'])).toThrow(/unexpected argument/);
  });

  it('--help throws with the usage banner', () => {
    expect(() => parseDoctorArgs(['--help'])).toThrow(/kb doctor/);
  });
});

describe('formatReportMarkdown', () => {
  it('reports healthy when active_model + active_index resolve', () => {
    const out = formatReportMarkdown(baseReport());
    expect(out).toMatch(/^kb doctor: healthy/);
  });

  it('reports UNHEALTHY when the active model is unresolved', () => {
    const out = formatReportMarkdown(baseReport({ active_model: null, healthy: false }));
    expect(out).toMatch(/^kb doctor: UNHEALTHY/);
    expect(out).toContain('active_model: <unresolved>');
  });

  it('reports UNHEALTHY when the active index is missing', () => {
    const out = formatReportMarkdown(baseReport({
      active_index: { path: null, mtime: null },
      healthy: false,
    }));
    expect(out).toContain('active_index: <missing>');
  });

  it('renders per-KB stale counts (modified + new) one row per KB', () => {
    const out = formatReportMarkdown(baseReport());
    expect(out).toMatch(/alpha\s+total=5\s+modified=0\s+new=1/);
    expect(out).toMatch(/beta\s+total=3\s+modified=2\s+new=0/);
  });

  it('says "(none registered)" when there are no KBs', () => {
    const out = formatReportMarkdown(baseReport({ knowledge_bases: [] }));
    expect(out).toContain('knowledge_bases: (none registered');
  });

  it('shows git HEAD + origin/main + behind count when running from a worktree', () => {
    const out = formatReportMarkdown(baseReport({
      checkout: {
        linked: false,
        realpath: '/home/me/kb-dev/build/cli.js',
        worktree: '/home/me/kb-dev',
        git: {
          head: 'abc1234' + '0'.repeat(33),
          origin_main: 'def5678' + '0'.repeat(33),
          behind_origin_main: 2,
        },
      },
    }));
    expect(out).toContain('checkout: dev checkout');
    expect(out).toContain('worktree=/home/me/kb-dev');
    expect(out).toMatch(/HEAD:\s+abc1234/);
    expect(out).toMatch(/origin\/main:\s+def5678/);
    expect(out).toMatch(/behind:\s+2 commits/);
  });

  it('labels a linked dev install distinctly and shows the realpath', () => {
    const out = formatReportMarkdown(baseReport({
      checkout: {
        linked: true,
        realpath: '/home/me/kb-dev/build/cli.js',
        worktree: '/home/me/kb-dev',
        git: { head: null, origin_main: null, behind_origin_main: null },
      },
    }));
    expect(out).toContain('checkout: linked dev install');
    expect(out).toContain('realpath:    /home/me/kb-dev/build/cli.js');
  });

  it('singular vs plural commit suffix', () => {
    const oneBehind = formatReportMarkdown(baseReport({
      checkout: {
        linked: false,
        realpath: '/x',
        worktree: '/x',
        git: { head: 'h', origin_main: 'o', behind_origin_main: 1 },
      },
    }));
    expect(oneBehind).toMatch(/behind:\s+1 commit$/m);
  });

  it('falls back to "installed binary" when no worktree is detected', () => {
    const out = formatReportMarkdown(baseReport({
      checkout: { linked: false, realpath: '/usr/local/bin/kb', worktree: null },
    }));
    expect(out).toContain('checkout: installed binary');
  });

  it('always terminates the report with a single trailing newline', () => {
    const out = formatReportMarkdown(baseReport());
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});
