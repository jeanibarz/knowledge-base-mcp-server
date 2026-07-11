// Unit + integration coverage for the centralized `kb` CLI exit-code taxonomy
// (issue #733). Asserts the frozen map itself and that the shipped CLI's
// top-level help manifest and help prose are both derived from it — so the
// runtime and its documentation cannot drift.

import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  EXIT,
  EXIT_DESCRIPTIONS,
  exitCodeDocs,
  formatExitCodesHelp,
} from './cli-exit-codes.js';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

function runCli(args: string[]): { status: number; stdout: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

describe('EXIT taxonomy', () => {
  it('pins the documented numeric codes and keeps 0/1 backward-compatible', () => {
    expect(EXIT).toEqual({
      OK: 0,
      INTERNAL: 1,
      USAGE: 2,
      CONFIG: 3,
      NO_RESULTS: 4,
      BACKEND_UNAVAILABLE: 5,
    });
    // 0 = success, 1 = generic failure must never move (existing scripts rely on it).
    expect(EXIT.OK).toBe(0);
    expect(EXIT.INTERNAL).toBe(1);
  });

  it('assigns a unique code to every name', () => {
    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('is frozen so callers cannot mutate the taxonomy at runtime', () => {
    expect(Object.isFrozen(EXIT)).toBe(true);
    expect(Object.isFrozen(EXIT_DESCRIPTIONS)).toBe(true);
    expect(() => {
      (EXIT as unknown as Record<string, number>).OK = 99;
    }).toThrow();
    expect(EXIT.OK).toBe(0);
  });

  it('documents every code', () => {
    for (const name of Object.keys(EXIT) as (keyof typeof EXIT)[]) {
      expect(EXIT_DESCRIPTIONS[name]).toEqual(expect.any(String));
      expect(EXIT_DESCRIPTIONS[name].length).toBeGreaterThan(0);
    }
  });

  it('exposes ordered { code, description } docs', () => {
    const docs = exitCodeDocs();
    expect(docs.map((d) => d.code)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(docs[0]).toEqual({ code: 0, description: EXIT_DESCRIPTIONS.OK });
  });

  it('renders an aligned help section body', () => {
    const help = formatExitCodesHelp();
    expect(help.split('\n')).toHaveLength(exitCodeDocs().length);
    expect(help).toContain('  0   success (results found or empty)');
    expect(help).toContain('  5   backend unavailable (transient / retryable)');
  });
});

describe('help manifest is derived from the taxonomy (no prose parsing)', () => {
  it('kb help --format=json exit_codes equal exitCodeDocs()', () => {
    const { status, stdout } = runCli(['help', '--format=json']);
    expect(status).toBe(0);
    const manifest = JSON.parse(stdout) as { exit_codes: Array<{ code: number; description: string }> };
    expect(manifest.exit_codes).toEqual(exitCodeDocs());
  });

  it('kb --help prose renders the taxonomy from the shared map', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain(formatExitCodesHelp());
  });
});
