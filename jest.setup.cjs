// Issue #661 — raise the per-test timeout for coverage-instrumented runs.
// `--coverage` (istanbul) roughly doubles execution time, and a few tests
// lazily `import()` heavy modules (e.g. FaissIndexManager + its
// faiss/langchain graph) on first use; under coverage on the slower Node 20
// CI runner that first instrumented import can exceed Jest's 5s default.
// `jest.setTimeout()` from a `setupFilesAfterEnv` file reliably overrides the
// default for every test in both `projects`, where the project-level
// `testTimeout` config key is silently ignored. Fast, uninstrumented
// `npm test` runs are unaffected — they still finish well under the cap.
jest.setTimeout(30000);

// Issue #1092 / #1180 — environment isolation (user-level kb config, HOME,
// knowledge-base root, index directory, kb env vars) lives in
// jest.global-setup.cjs. It has to run in the Jest parent process: edits to
// `process.env` made here only reach the current test file's sandbox copy,
// never the workers' real environment or the child processes tests spawn.
