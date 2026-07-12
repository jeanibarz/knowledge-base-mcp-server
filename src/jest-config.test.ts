import { execFileSync } from 'node:child_process';

describe('Jest serial project configuration', () => {
  it('keeps both projects aligned across E2E modes', () => {
    const serialPathPatterns = [
      '<rootDir>/src/FaissIndexManager.test.ts',
      '<rootDir>/src/KnowledgeBaseServer.test.ts',
      '<rootDir>/src/cli-doctor.test.ts',
      '<rootDir>/src/docstore-cas.integration.test.ts',
      '<rootDir>/src/docstore-cas.test.ts',
      '<rootDir>/src/recursive-fs-watch.test.ts',
      '<rootDir>/src/reindex-runner.test.ts',
      '<rootDir>/src/transport/http.test.ts',
      '<rootDir>/src/transport/sse.test.ts',
      '<rootDir>/src/triggerWatcher.test.ts',
      '<rootDir>/src/write-lock.test.ts',
      '<rootDir>/tests/stress/',
    ];
    const serialTestMatch = [
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
    ];

    for (const e2eEnabled of [false, true]) {
      const config = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "const { default: config } = await import('./jest.config.js'); console.log(JSON.stringify(config.projects.map(({ displayName, testMatch, testPathIgnorePatterns }) => ({ displayName, testMatch, testPathIgnorePatterns }))));",
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, KB_RUN_E2E: e2eEnabled ? '1' : '0' },
        },
      );
      const projects = JSON.parse(config) as Array<{
        displayName: string;
        testMatch: string[];
        testPathIgnorePatterns: string[];
      }>;
      const parallel = projects.find(({ displayName }) => displayName === 'parallel');
      const serial = projects.find(({ displayName }) => displayName === 'serial');
      const expectedSerialTestMatch = [
        ...serialTestMatch,
        ...(e2eEnabled ? ['**/src/e2e/**/*.test.ts'] : []),
      ];

      expect(serial?.testMatch).toEqual(expectedSerialTestMatch);
      expect(serial?.testPathIgnorePatterns).toEqual([
        '/node_modules/',
        ...(e2eEnabled ? [] : ['<rootDir>/src/e2e/']),
      ]);
      expect(parallel?.testPathIgnorePatterns).toEqual([
        '/node_modules/',
        ...serialPathPatterns,
        '<rootDir>/src/e2e/',
      ]);
    }
  });
});
