/** @type {import('ts-jest').JestConfigWithTsJest} */

// Issue #222 — the spawn-the-binary E2E suite under `src/e2e/` boots
// `build/index.js` as a child process per test and adds seconds of
// wall-time to a run that is otherwise milliseconds. It is opt-in:
// default `npm test` excludes it via `testPathIgnorePatterns`, while
// `KB_RUN_E2E=1 npm test` (or `KB_RUN_E2E=1 jest src/e2e`) drops the
// exclusion and runs the suite. The tests themselves also `describe.skip`
// when the gate is off, so a contributor who narrows to a specific file
// (`jest --runTestsByPath src/e2e/mcp-binary.e2e.test.ts`) without the
// env var still sees a clean "skipped" line rather than an opaque hang.
const e2eEnabled = process.env.KB_RUN_E2E === '1';

export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    "**/src/**/*.test.ts",
    "**/benchmarks/**/*.test.ts",
    "**/tests/stress/**/*.test.ts",
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(e2eEnabled ? [] : ['<rootDir>/src/e2e/']),
  ],
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
