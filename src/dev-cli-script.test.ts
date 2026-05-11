import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const devCliScriptPath = path.join(process.cwd(), 'scripts', 'dev-cli.mjs');

describe('dev:cli wrapper', () => {
  it('runs the TypeScript CLI help path and prints the active environment to stderr', () => {
    const tempDir = path.join(os.tmpdir(), `kb-dev-cli-${process.pid}`);
    const rootDir = path.join(tempDir, 'knowledge-bases');
    const faissDir = path.join(tempDir, '.faiss');
    const result = spawnSync(
      process.execPath,
      ['--enable-source-maps', '--import', 'tsx', devCliScriptPath, '--help'],
      {
        env: {
          PATH: process.env.PATH ?? '',
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'ollama',
          OLLAMA_MODEL: 'nomic-embed-text:test',
        },
        encoding: 'utf-8',
      },
    );

    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kb — knowledge-base CLI');
    expect(result.stdout).toContain('Available commands:');
    expect(result.stderr).toContain('dev:cli environment:');
    expect(result.stderr).toContain(`KNOWLEDGE_BASES_ROOT_DIR=${rootDir}`);
    expect(result.stderr).toContain(`FAISS_INDEX_PATH=${faissDir}`);
    expect(result.stderr).toContain('EMBEDDING_PROVIDER=ollama');
    expect(result.stderr).toContain('EMBEDDING_MODEL=nomic-embed-text:test');
  });
});
