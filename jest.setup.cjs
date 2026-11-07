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

// Issue #1092 — keep the suite hermetic against a developer's user-level
// `$XDG_CONFIG_HOME/kb/kb.config.yaml`. `findProjectConfig()` falls back to
// that file and `initializeProjectConfig()` copies its keys into
// `process.env` at module import time, so a local config could silently
// change test outcomes (CI runners have none, hiding the leak). Point
// XDG_CONFIG_HOME at a per-process directory that is never created; the
// lookup then finds nothing. Tests that need a config dir still set
// XDG_CONFIG_HOME themselves, and spawned children inherit this value.
{
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  process.env.XDG_CONFIG_HOME = nodePath.join(
    nodeOs.tmpdir(),
    `kb-jest-no-user-config-${process.pid}`,
  );
}
