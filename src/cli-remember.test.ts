import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildBlockedJson,
  candidatesFromResults,
  formatBlockedMarkdown,
  type SimilarCandidate,
} from './cli-remember-similarity.js';
// `parseRememberArgs` lives in cli-remember.ts; importing it transitively
// pulls in markdown-section.ts -> mdast-util-from-markdown (pure ESM that
// ts-jest cannot transform). We exercise the parser end-to-end via the
// child-process tests in cli.test.ts instead.
import type { ScoredDocument } from './formatter.js';
import { slugifyTitle } from './slug.js';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

function runCli(args: string[], env: Record<string, string>, input?: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('node', [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? '', KB_LOG_FORMAT: 'text', ...env },
    encoding: 'utf-8',
    input,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('candidatesFromResults', () => {
  function doc(score: number, kb: string | null, relPath: string | null, content: string): ScoredDocument {
    const metadata: Record<string, unknown> = {};
    if (kb !== null) metadata.knowledgeBase = kb;
    if (relPath !== null) metadata.relativePath = relPath;
    return { pageContent: content, metadata, score };
  }

  it('strips the KB-name prefix from relativePath so suggested_invocation is reusable', () => {
    const results = [
      doc(0.42, 'ops', 'ops/runbooks/deploy.md', 'Deploy the service via the CI pipeline.'),
    ];
    const candidates = candidatesFromResults(results, 'ops');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].knowledge_base).toBe('ops');
    expect(candidates[0].relative_path).toBe('runbooks/deploy.md');
    expect(candidates[0].suggested_invocation).toBe(
      'kb remember --kb=ops --append=runbooks/deploy.md --stdin --yes',
    );
  });

  it('falls back to the supplied default KB when metadata.knowledgeBase is missing', () => {
    const results = [doc(0.5, null, 'cross-kb/note.md', 'body')];
    const candidates = candidatesFromResults(results, 'fallback-kb');
    expect(candidates[0].knowledge_base).toBe('fallback-kb');
  });

  it('skips results that have no relativePath metadata (cannot build an actionable invocation)', () => {
    const results = [doc(0.4, 'ops', null, 'body')];
    expect(candidatesFromResults(results, 'ops')).toEqual([]);
  });

  it('truncates long pageContent to a bounded excerpt', () => {
    const long = 'a'.repeat(10000);
    const results = [doc(0.3, 'ops', 'ops/big.md', long)];
    const c = candidatesFromResults(results, 'ops');
    expect(c[0].chunk.length).toBeLessThan(long.length);
    expect(c[0].chunk.endsWith('…')).toBe(true);
  });

  it('preserves score verbatim from the FAISS result', () => {
    const results = [doc(0.123456, 'ops', 'ops/x.md', 'content')];
    expect(candidatesFromResults(results, 'ops')[0].score).toBeCloseTo(0.123456, 6);
  });
});

describe('buildBlockedJson', () => {
  it('produces the agent-facing JSON shape required by issue #154', () => {
    const candidates: SimilarCandidate[] = [
      {
        knowledge_base: 'operating-environment',
        relative_path: 'update-local-kb-cli-from-symlinked-checkout.md',
        score: 0.42,
        chunk: '...matching chunk text...',
        suggested_invocation: 'kb remember --kb=operating-environment --append=update-local-kb-cli-from-symlinked-checkout.md --stdin --yes',
      },
    ];
    const out = buildBlockedJson(candidates);
    expect(out.action).toBe('similarity-check');
    expect(out.write_performed).toBe(false);
    expect(out.decision_hint.summary).toMatch(/Similar KB chunks/);
    expect(out.decision_hint.recommended_agent_actions).toHaveLength(3);
    expect(out.decision_hint.recommended_agent_actions[2]).toMatch(/--force/);
    expect(out.candidates).toBe(candidates);
  });
});

describe('formatBlockedMarkdown', () => {
  it('renders header, decision hint, and one section per candidate', () => {
    const candidates: SimilarCandidate[] = [
      {
        knowledge_base: 'ops',
        relative_path: 'runbooks/deploy.md',
        score: 0.42,
        chunk: 'matched chunk text',
        suggested_invocation: 'kb remember --kb=ops --append=runbooks/deploy.md --stdin --yes',
      },
      {
        knowledge_base: 'ops',
        relative_path: 'runbooks/rollback.md',
        score: 0.71,
        chunk: 'second match',
        suggested_invocation: 'kb remember --kb=ops --append=runbooks/rollback.md --stdin --yes',
      },
    ];
    const out = formatBlockedMarkdown(candidates);
    expect(out).toContain('blocked by --check-similar guard');
    expect(out).toContain('Similar KB chunks were found before writing.');
    expect(out).toContain('## Candidate 1');
    expect(out).toContain('## Candidate 2');
    expect(out).toContain('runbooks/deploy.md');
    expect(out).toContain('Score: 0.42 (lower distance = closer match)');
    expect(out).toContain('rerun with --force');
  });
});

describe('kb remember write policy', () => {
  it('denies creates when the target shelf policy denies mutations', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-policy-create-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(path.join(kbDir, '.kb-policy.json'), '{"mutations":"deny"}\n', 'utf-8');

      const r = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes', '--no-check-similar'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '# Draft\n',
      );

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('KB write policy denies mutations');
      await expect(fsp.stat(path.join(kbDir, 'draft.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses managed appends to the policy file itself', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-policy-file-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      const policyPath = path.join(kbDir, '.kb-policy.json');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(policyPath, '{"mutations":"allow"}\n', 'utf-8');

      const r = runCli(
        ['remember', '--kb=project', '--append=.kb-policy.json', '--stdin', '--yes', '--no-check-similar'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '{"mutations":"deny"}\n',
      );

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('cannot modify .kb-policy.json');
      await expect(fsp.readFile(policyPath, 'utf-8')).resolves.toBe('{"mutations":"allow"}\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('kb remember non-Latin titles (issue #890)', () => {
  it('creates distinct files for two different non-Latin titles', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-non-latin-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      await fsp.mkdir(kbDir, { recursive: true });

      const titleA = '第一个笔记';
      const titleB = '第二个笔记';
      const env = { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir };

      const r1 = runCli(
        ['remember', '--kb=project', `--title=${titleA}`, '--stdin', '--yes', '--no-check-similar'],
        env,
        '# 第一个\n\nbody a\n',
      );
      const r2 = runCli(
        ['remember', '--kb=project', `--title=${titleB}`, '--stdin', '--yes', '--no-check-similar'],
        env,
        '# 第二个\n\nbody b\n',
      );

      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);

      const pathA = `${slugifyTitle(titleA)}.md`;
      const pathB = `${slugifyTitle(titleB)}.md`;
      expect(pathA).not.toBe(pathB);
      expect(pathA).not.toBe('note.md');
      expect(pathB).not.toBe('note.md');

      await expect(fsp.readFile(path.join(kbDir, pathA), 'utf-8')).resolves.toContain('body a');
      await expect(fsp.readFile(path.join(kbDir, pathB), 'utf-8')).resolves.toContain('body b');
      await expect(fsp.stat(path.join(kbDir, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('still refuses to overwrite when the same non-Latin title is remembered twice', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-non-latin-dup-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      await fsp.mkdir(kbDir, { recursive: true });

      const title = '同じタイトル';
      const env = { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir };
      const relativePath = `${slugifyTitle(title)}.md`;

      const r1 = runCli(
        ['remember', '--kb=project', `--title=${title}`, '--stdin', '--yes', '--no-check-similar'],
        env,
        '# once\n',
      );
      const r2 = runCli(
        ['remember', '--kb=project', `--title=${title}`, '--stdin', '--yes', '--no-check-similar'],
        env,
        '# twice\n',
      );

      expect(r1.code).toBe(0);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toContain(`refusing to overwrite existing note: ${relativePath}`);
      await expect(fsp.readFile(path.join(kbDir, relativePath), 'utf-8')).resolves.toContain('# once');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

