import { extractReadmeCommands, findUnknownCommands } from './check-readme-cli-commands.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('extracts commands from code spans and fences only', () => {
  const md = 'Run `kb doctor` now. The kb tool is nice.\n```bash\nkb search "x" --k=5\necho hi | kb remember --stdin\n```\n';
  assert.deepEqual(extractReadmeCommands(md), ['doctor', 'remember', 'search']);
});

test('flags commands missing from the CLI', () => {
  assert.deepEqual(findUnknownCommands('`kb doctor` and `kb bogus`', ['doctor']), ['bogus']);
});
