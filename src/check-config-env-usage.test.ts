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
});
