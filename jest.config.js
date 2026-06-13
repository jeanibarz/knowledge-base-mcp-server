/** @type {import('ts-jest').JestConfigWithTsJest} */

// Issue #222 - the spawn-the-binary E2E suite under `src/e2e/` boots
// `build/index.js` as a child process per test and adds seconds of
// wall-time to a run that is otherwise milliseconds. It is opt-in:
// default `npm test` excludes it via `testPathIgnorePatterns`, while
// `KB_RUN_E2E=1 npm test` (or `KB_RUN_E2E=1 jest src/e2e`) drops the
// exclusion and runs the suite. The tests themselves also `describe.skip`
// when the gate is off, so a contributor who narrows to a specific file
// (`jest --runTestsByPath src/e2e/mcp-binary.e2e.test.ts`) without the
// env var still sees a clean "skipped" line rather than an opaque hang.
const e2eEnabled = process.env.KB_RUN_E2E === '1';

const baseTestMatch = [
  '**/src/**/*.test.ts',
  '**/benchmarks/**/*.test.ts',
  '**/tests/stress/**/*.test.ts',
];

const serialTestPathPatterns = [
  '<rootDir>/src/FaissIndexManager.test.ts',
  '<rootDir>/src/KnowledgeBaseServer.test.ts',
  '<rootDir>/src/docstore-cas.integration.test.ts',
  '<rootDir>/src/docstore-cas.test.ts',
  '<rootDir>/src/recursive-fs-watch.test.ts',
  '<rootDir>/src/reindex-runner.test.ts',
  '<rootDir>/src/transport/http.test.ts',
  '<rootDir>/src/transport/sse.test.ts',
  '<rootDir>/src/triggerWatcher.test.ts',
  '<rootDir>/src/write-lock.test.ts',
  '<rootDir>/tests/stress/',
  ...(e2eEnabled ? ['<rootDir>/src/e2e/'] : []),
];

const baseConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
};

export default {
  projects: [
    {
      ...baseConfig,
      displayName: 'parallel',
      testMatch: baseTestMatch,
      testPathIgnorePatterns: [
        '/node_modules/',
        ...serialTestPathPatterns,
        ...(e2eEnabled ? [] : ['<rootDir>/src/e2e/']),
      ],
    },
    {
      ...baseConfig,
      displayName: 'serial',
      testMatch: [
        '**/src/FaissIndexManager.test.ts',
        '**/src/KnowledgeBaseServer.test.ts',
        '**/src/docstore-cas.integration.test.ts',
        '**/src/docstore-cas.test.ts',
        '**/src/recursive-fs-watch.test.ts',
        '**/src/reindex-runner.test.ts',
        '**/src/transport/http.test.ts',
        '**/src/transport/sse.test.ts',
        '**/src/triggerWatcher.test.ts',
        '**/src/write-lock.test.ts',
        '**/tests/stress/**/*.test.ts',
        ...(e2eEnabled ? ['**/src/e2e/**/*.test.ts'] : []),
      ],
      testPathIgnorePatterns: [
        '/node_modules/',
        ...(e2eEnabled ? [] : ['<rootDir>/src/e2e/']),
      ],
    },
  ],
};
