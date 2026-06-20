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
  ...(e2eEnabled ? ['<rootDir>/src/e2e/'] : []),
];

const baseConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Issue #661 — `jest.setTimeout(30000)` lifts the per-test timeout so
  // coverage-instrumented runs don't trip Jest's 5s default on the slower
  // Node 20 CI runner (see jest.setup.cjs). Loaded into BOTH projects; the
  // project-level `testTimeout` key is silently ignored under `projects`.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
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

// Issue #661 — coverage is opt-in via `--coverage` (wired into
// `npm run check`/CI as `npm run test:coverage`), keeping the inner-loop
// `npm test` fast since instrumentation adds noticeable runtime. With a
// multi-`projects` config Jest aggregates coverage globally and enforces
// the threshold from this root object, so these keys live here rather than
// inside `baseConfig`. The denominator is the shippable `src/` tree: test
// files, fixtures, property-test helpers, the spawn-the-binary `e2e/`
// harness, and type declarations are excluded so untested *product* code is
// what moves the numbers.
const coverageConfig = {
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__fixtures__/**',
    '!src/**/__property-tests__/**',
    '!src/**/__mocks__/**',
    '!src/e2e/**',
    '!src/**/*.d.ts',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/build/',
    '<rootDir>/benchmarks/',
  ],
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  // Baseline measured 2026-06-16 (`jest --coverage`):
  // statements 74.24% · branches 64.41% · functions 79.81% · lines 76.37%.
  // Floors sit a few points under each so the gate catches regressions
  // without flaking on run-to-run jitter — raise them as coverage climbs.
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 60,
      functions: 75,
      lines: 72,
    },
  },
};

export default {
  // Root-level coverage collection uses the root transform, not only the
  // per-project transforms, when instrumenting untested source files.
  ...baseConfig,
  ...coverageConfig,
  // Issue #661 — `--coverage` (istanbul) instrumentation roughly doubles
  // execution time, and a few tests lazily `import()` heavy modules
  // (e.g. FaissIndexManager + its faiss/langchain graph) on first use.
  // Under coverage on the slower Node 20 CI runner that first instrumented
  // import can exceed Jest's 5s default, so raise the ceiling. `testTimeout`
  // is a global-only option (Jest rejects it inside a `projects[]` entry),
  // so it lives here. This only lifts the cap — fast, uninstrumented
  // `npm test` runs are unaffected since they still finish well under it.
  testTimeout: 30000,
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
        ...(e2eEnabled ? ['**/src/e2e/**/*.test.ts'] : []),
      ],
      testPathIgnorePatterns: [
        '/node_modules/',
        ...(e2eEnabled ? [] : ['<rootDir>/src/e2e/']),
      ],
    },
  ],
};
