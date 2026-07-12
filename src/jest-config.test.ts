import { execFileSync } from 'node:child_process';

describe('Jest serial project configuration', () => {
  it('keeps the existing serial test partition', () => {
    const config = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { default: config } = await import('./jest.config.js'); console.log(JSON.stringify(config.projects.find(({ displayName }) => displayName === 'serial').testMatch));",
      ],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(config)).toEqual([
      '**/src/FaissIndexManager.test.ts',
      '**/src/KnowledgeBaseServer.test.ts',
      '**/src/cli-doctor.test.ts',
      '**/src/docstore-cas.integration.test.ts',
      '**/src/docstore-cas.test.ts',
      '**/src/recursive-fs-watch.test.ts',
      '**/src/reindex-runner.test.ts',
      '**/src/transport/http.test.ts',
      '**/src/transport/sse.test.ts',
      '**/src/triggerWatcher.test.ts',
      '**/src/write-lock.test.ts',
      '**/tests/stress/**/*.test.ts',
      ...(process.env.KB_RUN_E2E === '1' ? ['**/src/e2e/**/*.test.ts'] : []),
    ]);
  });
});
