import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const scriptPath = path.join(process.cwd(), 'scripts', 'check-config-env-usage.mjs');

function runGuard(extraRoots: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...extraRoots], {
    encoding: 'utf-8',
    env: { ...process.env, LOG_FILE: '' },
  });
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr };
}

describe('config:check-env-usage guard', () => {
  it('passes on the current production source (main stays green)', () => {
    const { status, stderr } = runGuard([]);
    expect(stderr).toContain('no unregistered controlled env reads');
    expect(status).toBe(0);
  });

  it('fails when code reads a controlled env var that is not registered or allowlisted', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-env-usage-'));
    try {
      const fixtureFile = path.join(fixtureDir, 'fake-config.ts');
      fs.writeFileSync(
        fixtureFile,
        'export const flag = process.env.KB_FAKE_UNREGISTERED_XYZ ?? "off";\n',
      );
      const { status, stderr } = runGuard([fixtureDir]);
      expect(status).toBe(1);
      expect(stderr).toContain('KB_FAKE_UNREGISTERED_XYZ');
      expect(stderr).toContain('not registered in CONFIG_SCHEMA');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('ignores dynamic process.env[var] access (only literal names are checked)', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-env-usage-'));
    try {
      fs.writeFileSync(
        path.join(fixtureDir, 'dynamic.ts'),
        'export const read = (name: string) => process.env[name];\n',
      );
      const { status } = runGuard([fixtureDir]);
      expect(status).toBe(0);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['an env parameter', 'export const a = (env: NodeJS.ProcessEnv) => env.KB_FAKE_INDIRECT_ONE;\n', 'KB_FAKE_INDIRECT_ONE'],
    ['a bracket read on an env parameter', "export const a = (env: NodeJS.ProcessEnv) => env['KB_FAKE_INDIRECT_TWO'];\n", 'KB_FAKE_INDIRECT_TWO'],
    ['an *_ENV name constant', "export const FAKE_ENV = 'KB_FAKE_INDIRECT_THREE';\n", 'KB_FAKE_INDIRECT_THREE'],
    ['an env helper call', "export const a = envInteger('KB_FAKE_INDIRECT_FOUR');\n", 'KB_FAKE_INDIRECT_FOUR'],
  ])('fails on an unregistered var read through %s', (_label, source, name) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-env-usage-'));
    try {
      fs.writeFileSync(path.join(fixtureDir, 'indirect.ts'), source);
      const { status, stderr } = runGuard([fixtureDir]);
      expect(status).toBe(1);
      expect(stderr).toContain(name);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
