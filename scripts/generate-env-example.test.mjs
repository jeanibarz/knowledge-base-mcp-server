import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { checkEnvExample, generateEnvExample } from './generate-env-example.mjs';

test('groups entries, annotates defaults, and leaves secrets empty (#791)', () => {
  const output = generateEnvExample([
    { name: 'EMBEDDING_PROVIDER', kind: 'enum', default: 'fake', description: 'Embedding backend.' },
    { name: 'OPENAI_API_KEY', kind: 'secret', default: 'must-not-leak', description: 'Provider credential.' },
    { name: 'MCP_AUTH_TOKEN', kind: 'string', secret: true, default: 'also-secret' },
    { name: 'INDEXING_BATCH_SIZE', kind: 'integer', docDefault: '64; 16 for ollama' },
    { name: 'FUTURE_SETTING', kind: 'string', default: 'line one\nline two' },
  ]);

  assert.match(output, /# Embeddings/);
  assert.match(output, /# Embedding backend\./);
  assert.match(output, /EMBEDDING_PROVIDER=fake/);
  assert.match(output, /OPENAI_API_KEY=\n/);
  assert.match(output, /MCP_AUTH_TOKEN=\n/);
  assert.doesNotMatch(output, /must-not-leak|also-secret/);
  assert.match(output, /# Default: 64; 16 for ollama\nINDEXING_BATCH_SIZE=/);
  assert.match(output, /# Other/);
  assert.match(output, /FUTURE_SETTING="line one\\nline two"/);
});

test('rejects a stale generated template (#791)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-env-example-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = t.mock.method(process.stderr, 'write', () => true);
  await fs.writeFile(path.join(root, '.env.example'), 'stale\n', 'utf8');

  assert.equal(await checkEnvExample({ root }), false);
  assert.match(write.mock.calls[0].arguments[0], /.env.example is out of date/);
});
