import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'dev-doctor.mjs');

function tempOutDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kb-dev-doctor-${label}-${process.pid}-`));
}

function runScript(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--enable-source-maps', '--import', 'tsx', SCRIPT_PATH, ...args],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        LOG_FILE: '',
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

describe('npm run dev:doctor script', () => {
  it('prints help with --help', () => {
    const result = runScript(['--help']);
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run dev:doctor');
    expect(result.stdout).toContain('--dense=auto|skip|required');
    expect(result.stdout).toContain('--skip-build');
  });

  it('rejects unknown arguments with a non-zero exit code', () => {
    const result = runScript(['--nope']);
    if (result.error) throw result.error;
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });

  it('runs the scratch bootstrap check without using real KB paths', () => {
    const outDir = tempOutDir('run');
    fs.rmSync(outDir, { recursive: true, force: true });
    try {
      const result = runScript([
        '--dense=skip',
        '--keep',
        '--out=' + outDir,
        '--seed=11',
      ]);
      if (result.error) throw result.error;
      expect(result.status).toBe(0);

      const rootDir = path.join(outDir, 'knowledge_bases');
      const faissDir = path.join(outDir, 'faiss');
      expect(fs.statSync(path.join(rootDir, 'dev-fixture')).isDirectory()).toBe(true);
      expect(fs.statSync(faissDir).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(outDir, 'retrieval-eval.yml')).isFile()).toBe(true);

      expect(result.stdout).toContain('dev:doctor report');
      expect(result.stdout).toContain('[pass] build:');
      expect(result.stdout).toContain('[pass] fixture:');
      expect(result.stdout).toContain('[pass] faiss:');
      expect(result.stdout).toContain('[pass] local cli:');
      expect(result.stdout).toContain('[pass] kb list: listed dev-fixture');
      expect(result.stdout).toContain('[pass] lexical search:');
      expect(result.stdout).toContain('[skip] dense search: --dense=skip set');
      expect(result.stdout).toContain(`KNOWLEDGE_BASES_ROOT_DIR=${rootDir}`);
      expect(result.stdout).toContain(`FAISS_INDEX_PATH=${faissDir}`);
      expect(result.stdout).toMatch(/summary: \d+ passed, \d+ skipped, 0 failed/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
