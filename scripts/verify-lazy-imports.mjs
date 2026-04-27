#!/usr/bin/env node
// Issue #59 — empirical verification that switching EMBEDDING_PROVIDER only
// loads the active provider's @langchain module, not all three.
//
// Strategy:
//   1. Spawn one Node subprocess per provider. Each child gets a fresh
//      module graph (config.ts pins env values at module-load, so reusing a
//      single process would cache stale config).
//   2. Each child runs with --experimental-loader=./lazy-imports-trace-loader.mjs.
//      That loader appends every resolved module URL to a per-child trace
//      file. The probe reads the trace after `manager.initialize()` and
//      checks the inactive providers' URLs are absent.
//
// Run after `npm run build`:
//   node scripts/verify-lazy-imports.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const cases = [
  { provider: 'huggingface', extraEnv: { HUGGINGFACE_API_KEY: 'verify-fixture' } },
  {
    provider: 'ollama',
    extraEnv: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'mxbai-embed-large' },
  },
  {
    provider: 'openai',
    extraEnv: { OPENAI_API_KEY: 'verify-fixture', OPENAI_MODEL_NAME: 'text-embedding-3-small' },
  },
];

const PROBE = path.join(__dirname, 'verify-lazy-imports-probe.mjs');
const LOADER = path.join(__dirname, 'lazy-imports-trace-loader.mjs');

const traceDir = mkdtempSync(path.join(tmpdir(), 'kb-lazy-trace-'));

let anyFailure = false;
try {
  for (const c of cases) {
    const traceFile = path.join(traceDir, `${c.provider}.trace`);
    const env = {
      ...process.env,
      EMBEDDING_PROVIDER: c.provider,
      LAZY_IMPORTS_TRACE_FILE: traceFile,
      ...c.extraEnv,
    };
    for (const otherKey of ['HUGGINGFACE_API_KEY', 'OPENAI_API_KEY']) {
      if (!Object.prototype.hasOwnProperty.call(c.extraEnv, otherKey)) delete env[otherKey];
    }
    const res = spawnSync(
      process.execPath,
      ['--experimental-loader', LOADER, '--no-warnings=ExperimentalWarning', PROBE],
      { cwd: repoRoot, env, encoding: 'utf-8' },
    );
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    if (res.status !== 0) {
      anyFailure = true;
      console.error(`probe for ${c.provider} exited with status ${res.status}`);
    }
  }
} finally {
  rmSync(traceDir, { recursive: true, force: true });
}

if (anyFailure) {
  console.error('\nFAIL — at least one provider probe did not pass.');
  process.exit(1);
}
console.log('\nPASS — only the active provider was loaded for each EMBEDDING_PROVIDER value.');
