// Issue #1180 — remove the per-run sandbox created by jest.global-setup.cjs.
const fs = require('node:fs');
const { SANDBOX_KEY } = require('./jest.global-setup.cjs');

module.exports = async function globalTeardown() {
  const sandbox = globalThis[SANDBOX_KEY];
  if (!sandbox) return;
  globalThis[SANDBOX_KEY] = undefined;
  fs.rmSync(sandbox, { recursive: true, force: true });
};
