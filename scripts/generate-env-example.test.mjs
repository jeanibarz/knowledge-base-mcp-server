import assert from 'node:assert/strict';
import test from 'node:test';

import { generateEnvExample } from './generate-env-example.mjs';

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
