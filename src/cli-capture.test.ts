import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

function runCli(args: string[], env: Record<string, string>): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('node', [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? '', KB_LOG_FORMAT: 'text', ...env },
    encoding: 'utf-8',
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('kb capture write policy', () => {
  it('runs the command but refuses to append when shelf mutations are denied', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-capture-policy-deny-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      const notePath = path.join(kbDir, 'snapshots.md');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(notePath, '# Snapshots\n', 'utf-8');
      await fsp.writeFile(path.join(kbDir, '.kb-policy.json'), '{"mutations":"deny"}\n', 'utf-8');

      const r = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--', 'printf', 'captured'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('KB write policy denies mutations');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe('# Snapshots\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
