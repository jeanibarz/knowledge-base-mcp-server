// Issue #977 — end-to-end proof that `kb diagnose --to-fixture` writes a
// retrieval fixture that `kb eval` can actually run offline with the fake
// (deterministic, no-network) embedding provider. Spawns the built CLI in
// isolated temp dirs, exactly like the README commands the command generates.
import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');
const FAKE_MODEL_ID = 'fake__BAAI-bge-small-en-v1.5';
const FAKE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';

let tempRoot: string;
let homeDir: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync('node', [cliPath, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      KB_LOG_FORMAT: 'text',
      ...env,
    },
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function writeDiagnoseBundle(bundleDir: string): Promise<void> {
  await fsp.mkdir(path.join(bundleDir, 'explain'), { recursive: true });
  await fsp.writeFile(
    path.join(bundleDir, 'explain', 'query.txt'),
    'rollback procedure for blue green deploy\n',
    'utf-8',
  );
  await fsp.writeFile(
    path.join(bundleDir, 'explain', 'top-candidates.json'),
    JSON.stringify({
      schema_version: 'kb-explain-trace.v1',
      k: 3,
      candidates: [
        { rank: 1, score: 0.12, source: '/abs/ops/runbooks/deploy.md', relative_path: 'ops/runbooks/deploy.md', knowledge_base: 'ops', in_topk: true, frontmatter: { status: 'approved' } },
        { rank: 2, score: 0.20, source: '/abs/ops/notes/canary.md', relative_path: 'ops/notes/canary.md', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
        { rank: 3, score: 0.98, source: '/abs/ops/archive/old-deploy.md', relative_path: 'ops/archive/old-deploy.md', knowledge_base: 'ops', in_topk: false, frontmatter: {} },
      ],
    }),
    'utf-8',
  );
  await fsp.writeFile(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({ schema_version: 'kb.diagnose.repro_bundle.v1', selected_event: { kb_scope: 'ops', k: 3 } }),
    'utf-8',
  );
}

async function registerFakeModel(faissDir: string): Promise<void> {
  const modelDir = path.join(faissDir, 'models', FAKE_MODEL_ID);
  await fsp.mkdir(modelDir, { recursive: true });
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), FAKE_MODEL_NAME, 'utf-8');
  await fsp.writeFile(path.join(faissDir, 'active.txt'), FAKE_MODEL_ID, 'utf-8');
}

describe('kb diagnose --to-fixture end-to-end (issue #977)', () => {
  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-e2e-'));
    homeDir = path.join(tempRoot, 'home');
    await fsp.mkdir(homeDir, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('writes a fixture that kb eval runs green with fake embeddings', async () => {
    const bundleDir = path.join(tempRoot, 'bundle');
    const fixtureDir = path.join(tempRoot, 'fixture');
    await writeDiagnoseBundle(bundleDir);

    const scaffold = runCli(['diagnose', `--to-fixture=${bundleDir}`, `--out=${fixtureDir}`]);
    expect(scaffold.stderr).toBe('');
    expect(scaffold.code).toBe(0);

    const corpusRoot = path.join(fixtureDir, 'corpus');
    const faissDir = path.join(fixtureDir, '.faiss');
    await registerFakeModel(faissDir);

    const fakeEnv: NodeJS.ProcessEnv = {
      EMBEDDING_PROVIDER: 'fake',
      KB_FAKE_DIM: '32',
      KNOWLEDGE_BASES_ROOT_DIR: corpusRoot,
      FAISS_INDEX_PATH: faissDir,
    };

    const reindex = runCli(['reindex', '--with-context', '--force'], fakeEnv);
    expect(reindex.code).toBe(0);

    const evalRun = runCli(['eval', path.join(fixtureDir, 'fixture.yml')], fakeEnv);
    expect(evalRun.code).toBe(0);
    expect(evalRun.stdout).toContain('PASS diagnose repro');
    expect(evalRun.stdout).toMatch(/0 failed/);
  }, 60_000);
});
