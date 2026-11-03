/** @type {import('ts-jest').JestConfigWithTsJest} */

// Config for the two sharded coverage runs (`test:coverage:parallel` /
// `test:coverage:serial`). It is the normal jest config MINUS `coverageThreshold`:
// each shard only sees part of the suite, so per-shard threshold enforcement
// would always fail. The threshold is instead checked once, on the merged
// coverage, by scripts/coverage-merge-check.mjs. See package.json `test:coverage`.
import base from './jest.config.js';

const { coverageThreshold, ...withoutThreshold } = base;

export default withoutThreshold;
