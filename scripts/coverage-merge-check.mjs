#!/usr/bin/env node
// Merge the two sharded coverage runs into one report and enforce the global
// coverage threshold on the merged result.
//
// Why this exists: `test:coverage` used to be a single `jest --coverage
// --runInBand` over the whole suite, which forced the otherwise-parallel
// `parallel` project to run in one process — the dominant cost of the CI
// coverage job (~24 min vs ~3.5 min for the same tests without coverage). We
// now run the `parallel` project with workers and the `serial` project
// in-band as two shards, each emitting an istanbul `coverage-final.json`, and
// merge them here. Each shard sees only part of the suite, so the threshold
// cannot be enforced per-shard (jest's `coverageThreshold` is dropped in
// jest.coverage-shard.config.js); it is enforced here, once, on the union.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import jestConfig from '../jest.config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARD_DIRS = ['coverage/shard-parallel', 'coverage/shard-serial'];
const OUT_DIR = path.join(repoRoot, 'coverage');

const map = libCoverage.createCoverageMap({});
let shardsMerged = 0;
for (const dir of SHARD_DIRS) {
  const file = path.join(repoRoot, dir, 'coverage-final.json');
  if (!existsSync(file)) {
    console.error(`coverage-merge-check: missing shard coverage at ${dir}/coverage-final.json`);
    console.error('  run `npm run test:coverage:parallel` and `npm run test:coverage:serial` first.');
    process.exit(1);
  }
  map.merge(JSON.parse(readFileSync(file, 'utf8')));
  shardsMerged += 1;
}

// Write merged reports (parity with the old reporters: text-summary + lcov +
// json-summary) so CI artifacts and local output are unchanged in shape.
const context = libReport.createContext({ dir: OUT_DIR, coverageMap: map });
reports.create('text-summary').execute(context);
reports.create('lcov').execute(context);
reports.create('json-summary').execute(context);

// Compute the global summary from the merged map and enforce the thresholds
// declared in jest.config.js (single source of truth).
const globalSummary = libCoverage.createCoverageSummary();
for (const file of map.files()) {
  globalSummary.merge(map.fileCoverageFor(file).toSummary());
}

const thresholds = jestConfig.coverageThreshold?.global ?? {};
const metrics = ['statements', 'branches', 'functions', 'lines'];
const failures = [];
for (const metric of metrics) {
  const required = thresholds[metric];
  const pct = globalSummary.data[metric].pct;
  if (typeof required === 'number' && pct < required) {
    failures.push(`${metric}: ${pct}% < required ${required}%`);
  }
}

console.log(
  `coverage-merge-check: merged ${shardsMerged} shards, ${map.files().length} files · ` +
    metrics.map((m) => `${m} ${globalSummary.data[m].pct}%`).join(' · '),
);

if (failures.length > 0) {
  console.error('coverage-merge-check: FAILED coverage threshold:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('coverage-merge-check: thresholds met.');
