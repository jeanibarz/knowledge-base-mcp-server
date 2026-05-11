import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'dev-fixture.mjs');

function tempOutDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kb-dev-fixture-${label}-${process.pid}-`));
}

function runScript(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--enable-source-maps', '--import', 'tsx', SCRIPT_PATH, ...args],
    { encoding: 'utf-8', env: process.env },
  );
}

describe('npm run dev:fixture script', () => {
  it('prints help with --help without writing any files', () => {
    const result = runScript(['--help']);
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run dev:fixture');
    expect(result.stdout).toContain('--seed=<int>');
    expect(result.stdout).toContain('--profile=small|medium');
    expect(result.stdout).toContain('--out=<dir>');
  });

  it('rejects unknown arguments with a non-zero exit code', () => {
    const result = runScript(['--nope']);
    if (result.error) throw result.error;
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });

  it('rejects a non-integer --seed value', () => {
    const result = runScript(['--seed=not-a-number']);
    if (result.error) throw result.error;
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--seed must be an integer');
  });

  it('rejects an unknown --profile value', () => {
    const result = runScript(['--profile=enormous']);
    if (result.error) throw result.error;
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--profile must be one of');
  });

  it('generates a deterministic disposable knowledge base and retrieval-eval fixture', () => {
    const outDir = tempOutDir('shape');
    try {
      const result = runScript(['--out=' + outDir, '--seed=42', '--profile=small']);
      if (result.error) throw result.error;
      expect(result.status).toBe(0);

      const rootDir = path.join(outDir, 'knowledge_bases');
      const faissDir = path.join(outDir, 'faiss');
      const fixturePath = path.join(outDir, 'retrieval-eval.yml');
      const kbDir = path.join(rootDir, 'dev-fixture');

      expect(fs.statSync(rootDir).isDirectory()).toBe(true);
      expect(fs.statSync(faissDir).isDirectory()).toBe(true);
      expect(fs.statSync(kbDir).isDirectory()).toBe(true);
      expect(fs.statSync(fixturePath).isFile()).toBe(true);

      const corpus = fs.readdirSync(kbDir).filter((name) => name.endsWith('.md'));
      expect(corpus.length).toBeGreaterThanOrEqual(3);
      expect(corpus).toContain('doc-001.md');

      const docContent = fs.readFileSync(path.join(kbDir, 'doc-001.md'), 'utf-8');
      expect(docContent.length).toBeGreaterThan(0);
      expect(docContent).toMatch(/^# Fixture Document/);

      const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
      const parsed = yaml.load(fixtureContent) as {
        gate: boolean;
        cases: Array<{
          name: string;
          query: string;
          kb: string;
          required_sources: string[];
          stale_policy: string;
        }>;
      };
      expect(parsed.gate).toBe(false);
      expect(Array.isArray(parsed.cases)).toBe(true);
      expect(parsed.cases).toHaveLength(1);
      const [caseEntry] = parsed.cases;
      expect(caseEntry.kb).toBe('dev-fixture');
      expect(caseEntry.required_sources).toEqual(['dev-fixture/doc-001.md']);
      expect(caseEntry.stale_policy).toBe('allow_stale');
      expect(typeof caseEntry.query).toBe('string');
      expect(caseEntry.query.length).toBeGreaterThan(0);

      expect(result.stdout).toContain('Disposable seeded knowledge base ready.');
      expect(result.stdout).toContain(`KNOWLEDGE_BASES_ROOT_DIR=${rootDir}`);
      expect(result.stdout).toContain(`FAISS_INDEX_PATH=${faissDir}`);
      expect(result.stdout).toContain('kb list');
      expect(result.stdout).toContain('kb search');
      expect(result.stdout).toContain('--group-by-source');
      expect(result.stdout).toContain('--format=json');
      expect(result.stdout).toContain('kb eval');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('produces identical fixtures for the same seed and profile', () => {
    const outA = tempOutDir('a');
    const outB = tempOutDir('b');
    try {
      const first = runScript(['--out=' + outA, '--seed=7', '--profile=small']);
      const second = runScript(['--out=' + outB, '--seed=7', '--profile=small']);
      if (first.error) throw first.error;
      if (second.error) throw second.error;
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);

      const docA = fs.readFileSync(path.join(outA, 'knowledge_bases', 'dev-fixture', 'doc-001.md'), 'utf-8');
      const docB = fs.readFileSync(path.join(outB, 'knowledge_bases', 'dev-fixture', 'doc-001.md'), 'utf-8');
      expect(docA).toBe(docB);
    } finally {
      fs.rmSync(outA, { recursive: true, force: true });
      fs.rmSync(outB, { recursive: true, force: true });
    }
  });
});
