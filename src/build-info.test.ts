import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  readPackageVersion,
  resolveBuildCommit,
} from './build-info.js';

const ENV_KEYS = [
  'KB_BUILD_COMMIT',
  'SOURCE_VERSION',
  'GIT_COMMIT',
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('build info', () => {
  it('reads package version from the package root', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-build-info-'));
    await fsp.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ version: '1.2.3-test' }),
    );

    expect(readPackageVersion(tempDir)).toBe('1.2.3-test');
  });

  it.each(ENV_KEYS)('prefers %s build-time commit environment values', (key) => {
    process.env[key] = 'abc123def456';

    expect(resolveBuildCommit('/definitely/not/a/git/repo')).toBe('abc123def456');
  });

  it('falls back to unknown when an injected commit value is not a SHA', () => {
    process.env.KB_BUILD_COMMIT = 'main; rm -rf /';

    expect(resolveBuildCommit('/definitely/not/a/git/repo')).toBe('unknown');
  });
});
