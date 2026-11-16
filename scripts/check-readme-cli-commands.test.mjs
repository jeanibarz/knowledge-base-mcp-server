import { extractReadmeCommands, findUnknownCommands, findUnknownFlags } from './check-readme-cli-commands.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('extracts commands from code spans and fences only', () => {
  const md = 'Run `kb doctor` now. The kb tool is nice.\n```bash\nkb search "x" --k=5\necho hi | kb remember --stdin\n```\n';
  assert.deepEqual(extractReadmeCommands(md), ['doctor', 'remember', 'search']);
});

test('flags commands missing from the CLI', () => {
  assert.deepEqual(findUnknownCommands('`kb doctor` and `kb bogus`', ['doctor']), ['bogus']);
});

const REGISTRY = [
  { name: 'search', usage: ['kb search <query> --refresh [options]'], options: [{ flags: ['--tag'] }, { flags: ['--kb'] }] },
  { name: 'tags', usage: ['kb tags [--kb=<name>] [--facet=<name>] [--format=md|json]'], options: [] },
];

test('accepts flags from a command\'s options and usage lines', () => {
  const md = '```bash\nkb search q --tag=x --kb=work --refresh\nkb tags --facet=status --format=json\n```\n';
  assert.deepEqual(findUnknownFlags(md, REGISTRY), []);
});

test('flags undocumented flags, including inside a # shell comment (issue #1284)', () => {
  const md = '```bash\nkb tags --facet=status   # vocabulary for kb search --status filters\n```\nAlso `kb search q --type=x`.\n';
  assert.deepEqual(findUnknownFlags(md, REGISTRY), ['kb search --status', 'kb search --type']);
});

test('attributes flags to the nearest preceding command and stops at pipes', () => {
  const md = '```bash\nkb search q --tag=a | grep --color x\nkb tags --tag=a\n```\n';
  assert.deepEqual(findUnknownFlags(md, REGISTRY), ['kb tags --tag']);
});

test('skips commands absent from the registry', () => {
  assert.deepEqual(findUnknownFlags('`kb bogus --whatever`', REGISTRY), []);
});

test('checks flags on backslash-continued lines', () => {
  const md = '```bash\nkb search q \\\n  --status=x \\\n  --tag=y\n```\n';
  assert.deepEqual(findUnknownFlags(md, REGISTRY), ['kb search --status']);
});
