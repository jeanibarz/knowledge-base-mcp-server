// Issue #1180 — keep every Jest run hermetic against the developer's own
// machine state.
//
// Without this, a test that imports `config.js` resolves the developer's real
// knowledge-base root (`KNOWLEDGE_BASES_ROOT_DIR`, default `~/knowledge_bases`)
// and real index directory (`FAISS_INDEX_PATH`), and writes fixtures, preface
// sidecars and lock directories into them. CI never shows it because its
// runners start with an empty home directory and no kb configuration.
//
// This runs once in the Jest parent process, before any worker starts. That
// placement matters: Jest forks workers with the parent's real environment,
// and child processes spawned by tests (the built CLI, scripts) inherit the
// real environment too. A `setupFilesAfterEnv` file only edits the per-file
// sandbox copy of `process.env`, which spawned children never see.
//
// What it does:
//   1. Creates one throwaway directory under the OS temp dir for this run.
//   2. Points HOME, the knowledge-base root, the index directory and the XDG
//      config/state directories inside it, so every `os.homedir()` fallback
//      lands there as well.
//   3. Removes every inherited variable the config system controls (the
//      CONTROLLED_PREFIXES of src/config/schema.ts, e.g. EMBEDDING_PROVIDER,
//      OLLAMA_*, LOG_FILE, KB_DAEMON_URL), so a local run sees the same
//      configuration as CI. Tests that need a value set it themselves.
//      Opt-in test gates (`KB_RUN_E2E`, `KB_RUN_STRESS`, ...) are kept.
//
// `jest.global-teardown.cjs` deletes the directory after the run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mirror of CONTROLLED_PREFIXES in src/config/schema.ts. A guard test
// (src/test-hermeticity.test.ts) fails if the two lists drift apart.
const CONTROLLED_ENV_PREFIXES = [
  'KB_',
  'MCP_',
  'OLLAMA_',
  'OPENAI_',
  'HUGGINGFACE_',
  'FAISS_',
  'KNOWLEDGE_BASES_',
  'EMBEDDING_',
  'INGEST_',
  'INDEXING_',
  'REINDEX_',
  'FRONTMATTER_',
  'LOG_FILE',
];

// Variables that select which tests run rather than how the product behaves.
const PRESERVED_ENV_PATTERN = /^KB_RUN_/;

const SANDBOX_KEY = '__KB_JEST_SANDBOX_DIR__';

function isControlledEnvName(name) {
  return CONTROLLED_ENV_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
}

module.exports = async function globalSetup() {
  // `jest --watch` re-runs global setup; reuse the sandbox of this process.
  if (globalThis[SANDBOX_KEY]) return;

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-jest-'));
  globalThis[SANDBOX_KEY] = sandbox;

  for (const name of Object.keys(process.env)) {
    if (isControlledEnvName(name) && !PRESERVED_ENV_PATTERN.test(name)) {
      delete process.env[name];
    }
  }

  const home = path.join(sandbox, 'home');
  const kbRoot = path.join(home, 'knowledge_bases');
  const faissDir = path.join(kbRoot, '.faiss');
  fs.mkdirSync(faissDir, { recursive: true });

  process.env.HOME = home;
  process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
  process.env.FAISS_INDEX_PATH = faissDir;
  // Never created: the user-level kb.config.yaml lookup (#1092) finds nothing.
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
};

module.exports.CONTROLLED_ENV_PREFIXES = CONTROLLED_ENV_PREFIXES;
module.exports.SANDBOX_KEY = SANDBOX_KEY;
