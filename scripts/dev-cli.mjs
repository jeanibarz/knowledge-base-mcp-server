#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const cliSourcePath = path.join(repoRoot, 'src', 'cli.ts');
const passthroughArgs = process.argv.slice(2);

const {
  FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR,
} = await import('../src/config.ts');
const {
  computeLegacyEnvModelSpec,
  parseModelId,
  readStoredModelName,
  resolveActiveModel,
} = await import('../src/active-model.ts');
const { main } = await import('../src/cli.ts');

process.argv = [process.execPath, cliSourcePath, ...passthroughArgs];

async function resolveEmbeddingContext() {
  try {
    const modelId = await resolveActiveModel();
    const { provider } = parseModelId(modelId);
    return {
      provider,
      model: (await readStoredModelName(modelId)) ?? modelId,
    };
  } catch {
    const fallback = computeLegacyEnvModelSpec();
    return {
      provider: fallback.provider,
      model: fallback.modelName,
    };
  }
}

const embeddingContext = await resolveEmbeddingContext();

process.stderr.write([
  'dev:cli environment:',
  `  KNOWLEDGE_BASES_ROOT_DIR=${KNOWLEDGE_BASES_ROOT_DIR}`,
  `  FAISS_INDEX_PATH=${FAISS_INDEX_PATH}`,
  `  EMBEDDING_PROVIDER=${embeddingContext.provider}`,
  `  EMBEDDING_MODEL=${embeddingContext.model}`,
  '',
].join('\n'));

try {
  process.exitCode = await main(process.argv);
} catch (err) {
  const msg = err instanceof Error && err.stack ? err.stack : String(err);
  process.stderr.write(`kb dev:cli: fatal: ${msg}\n`);
  process.exitCode = 1;
}
