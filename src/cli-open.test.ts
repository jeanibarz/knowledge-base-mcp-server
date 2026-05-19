import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// `kb open` reads `KNOWLEDGE_BASES_ROOT_DIR` at module load, so these tests
// spawn the built CLI with a per-run temp KB — the same pattern as
// `cli-smoke.test.ts`. Pure reference parsing is covered separately by the
// `parseChunkReference` unit tests in `chunk-id.test.ts`.

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let kbRoot: string;
let deployAbsPath: string;

async function writeKb(): Promise<void> {
  kbRoot = path.join(tempDir, 'knowledge-bases');
  const docsDir = path.join(kbRoot, 'alpha', 'docs');
  await fsp.mkdir(docsDir, { recursive: true });
  const deployPath = path.join(docsDir, 'deploy.md');
  await fsp.writeFile(
    deployPath,
    '# Deploy\n\nLine three.\nLine four.\nLine five.\n',
    'utf-8',
  );
  // `resolveKbPath` returns a realpath-resolved path; resolve the fixture
  // the same way so exact-equality assertions hold even if the OS temp dir
  // is itself a symlink (e.g. /tmp -> /private/tmp).
  deployAbsPath = await fsp.realpath(deployPath);
}

function runOpen(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync('node', [cliPath, 'open', ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      KB_LOG_FORMAT: 'text',
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 8_000,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('kb open — resolve a retrieval reference to its source file', () => {
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-open-'));
    await writeKb();
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves a plain KB-relative path to the absolute source path', () => {
    const result = runOpen(['alpha/docs/deploy.md']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(deployAbsPath);
  });

  it('resolves a chunk id with an L<from>-L<to> fragment', () => {
    const result = runOpen(['alpha/docs/deploy.md#L2-L4']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(deployAbsPath);
  });

  it('resolves a kb:// resource URI', () => {
    const result = runOpen(['kb://alpha/docs/deploy.md']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(deployAbsPath);
  });

  it('emits a structured object with the cited line range under --json', () => {
    const result = runOpen(['alpha/docs/deploy.md#L2-L4', '--json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({
      target: 'alpha/docs/deploy.md#L2-L4',
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/deploy.md',
      path: deployAbsPath,
      line: 2,
      lineEnd: 4,
    });
    expect(body.editorUri).toBeUndefined();
  });

  it('adds editorUri to --json output when KB_EDITOR_URI is set', () => {
    const result = runOpen(
      ['alpha/docs/deploy.md#L2-L4', '--json'],
      { KB_EDITOR_URI: 'vscode' },
    );

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { editorUri?: string };
    expect(body.editorUri).toBe(`vscode://file${deployAbsPath}:2:0`);
  });

  it('exits 1 when a well-formed reference points at a missing file', () => {
    const result = runOpen(['alpha/docs/ghost.md#L1-L2']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('path not found');
  });

  it('exits 2 when the reference names an unknown knowledge base', () => {
    const result = runOpen(['nope/docs/deploy.md']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not found');
  });

  it('exits 2 when the reference path escapes the KB root', () => {
    const result = runOpen(['alpha/../../secret.md']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('kb open:');
  });

  it('exits 2 with an actionable error when no reference is given', () => {
    const result = runOpen([]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing <chunk-id');
  });

  it('exits 2 on an unknown option', () => {
    const result = runOpen(['alpha/docs/deploy.md', '--bogus']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--bogus'");
  });
});
