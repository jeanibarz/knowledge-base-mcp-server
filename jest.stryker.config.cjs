/** @type {import('ts-jest').JestConfigWithTsJest} */

// Issue #651 — a dedicated, single-project Jest config for Stryker mutation
// testing. The main `jest.config.js` uses a multi-`projects` layout plus a
// global `coverageThreshold`; Stryker's jest-runner drives Jest with only the
// tests related to each mutant, so those coverage floors would "fail" every
// mutant run and the `projects` indirection confuses the runner. This config
// mirrors the ESM/ts-jest transform from `baseConfig` but flattens it to one
// project, drops coverage gating, and scopes `testMatch` to the focused unit
// tests that cover the curated `mutate` set in stryker.conf.json.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
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
  testMatch: [
    '**/src/chunk-id.test.ts',
    '**/src/redaction.test.ts',
    '**/src/lexical-bm25.test.ts',
    '**/src/hybrid-retrieval.test.ts',
    '**/src/injection-guard.test.ts',
  ],
  testTimeout: 30000,
};
