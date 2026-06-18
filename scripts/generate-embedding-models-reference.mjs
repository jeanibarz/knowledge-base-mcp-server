#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EMBEDDING_MODELS_REFERENCE_PATH = 'docs/reference/embedding-models.md';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_PATHS = {
  providerConfig: 'src/config/provider.ts',
  embeddingProvider: 'src/embedding-provider.ts',
  costEstimates: 'src/cost-estimates.ts',
};

const MODEL_DOC_SOURCES = [
  '[Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)',
  '[Nomic text embedding docs](https://docs.nomic.ai/atlas/embeddings-and-retrieval/text-embedding)',
  '[OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)',
  '[BGE small model card](https://huggingface.co/BAAI/bge-small-en-v1.5)',
];

export async function generateEmbeddingModelsReferenceMarkdown({ root = REPO_ROOT } = {}) {
  const sources = await readSources(root);
  const providerConfig = sources.providerConfig;
  const embeddingProvider = sources.embeddingProvider;
  const costEstimates = sources.costEstimates;

  const knownProviders = parseKnownProviders(providerConfig);
  const defaults = {
    ollama: matchString(providerConfig, /export const OLLAMA_MODEL = process\.env\.OLLAMA_MODEL \|\| '([^']+)'/, 'OLLAMA_MODEL default'),
    openai: matchString(providerConfig, /export const DEFAULT_OPENAI_MODEL_NAME = '([^']+)'/, 'DEFAULT_OPENAI_MODEL_NAME'),
    huggingface: matchString(providerConfig, /export const DEFAULT_HUGGINGFACE_MODEL_NAME = '([^']+)'/, 'DEFAULT_HUGGINGFACE_MODEL_NAME'),
    fakeDim: matchNumber(providerConfig, /const DEFAULT_KB_FAKE_DIM = ([0-9]+)/, 'DEFAULT_KB_FAKE_DIM'),
    fakeMinDim: matchNumber(providerConfig, /const MIN_KB_FAKE_DIM = ([0-9]+)/, 'MIN_KB_FAKE_DIM'),
    fakeMaxDim: matchNumber(providerConfig, /const MAX_KB_FAKE_DIM = ([0-9]+)/, 'MAX_KB_FAKE_DIM'),
  };
  const nomicPrefixes = {
    query: matchString(embeddingProvider, /query: '([^']+)'/, 'nomic query task prefix'),
    document: matchString(embeddingProvider, /document: '([^']+)'/, 'nomic document task prefix'),
  };
  const costLastVerified = matchString(costEstimates, /export const LAST_VERIFIED = '([^']+)'/, 'cost LAST_VERIFIED');
  const deriveModelId = await loadDeriveModelId(root);

  assertExactValues(
    knownProviders,
    ['ollama', 'openai', 'huggingface', 'fake'],
    'KNOWN_EMBEDDING_PROVIDERS',
  );

  const rows = [
    {
      provider: 'ollama',
      model: defaults.ollama,
      modelId: deriveModelId('ollama', defaults.ollama),
      dimensions: '1024',
      prefixes: 'No',
      status: 'Default local production model. Requires Ollama and the pulled model.',
      notes: 'Qwen3-Embedding-0.6B has a 32k context window and configurable output dimensions up to 1024; this server does not pass a custom dimension parameter.',
    },
    {
      provider: 'ollama',
      model: 'nomic-embed-text or nomic-embed-text:latest',
      modelId: `${deriveModelId('ollama', 'nomic-embed-text')} / ${deriveModelId('ollama', 'nomic-embed-text:latest')}`,
      dimensions: '768',
      prefixes: `Yes: \`${nomicPrefixes.document}\` for documents, \`${nomicPrefixes.query}\` for queries`,
      status: 'Supported example model. Prefix behavior is covered by `src/embedding-provider.test.ts`.',
      notes: 'Pin the exact tag consistently. The model id is derived from the name as typed, so `nomic-embed-text` and `nomic-embed-text:latest` use different index directories.',
    },
    {
      provider: 'openai',
      model: defaults.openai,
      modelId: deriveModelId('openai', defaults.openai),
      dimensions: '1536',
      prefixes: 'No',
      status: 'Default OpenAI model. Requires `OPENAI_API_KEY` and paid API usage.',
      notes: `Cost prompts use the rule-of-thumb table in \`src/cost-estimates.ts\` (last verified ${costLastVerified}).`,
    },
    {
      provider: 'openai',
      model: 'text-embedding-3-large',
      modelId: deriveModelId('openai', 'text-embedding-3-large'),
      dimensions: '3072',
      prefixes: 'No',
      status: 'Supported by the generic OpenAI provider path and explicit cost tier.',
      notes: 'Higher storage and memory footprint than the default small model; run `kb models add ... --dry-run` before embedding a large corpus.',
    },
    {
      provider: 'openai',
      model: 'text-embedding-ada-002',
      modelId: deriveModelId('openai', 'text-embedding-ada-002'),
      dimensions: '1536',
      prefixes: 'No',
      status: 'Legacy-compatible override, not the default.',
      notes: 'Existing indexes can keep using this model id; new deployments should prefer the current OpenAI default unless they need compatibility.',
    },
    {
      provider: 'huggingface',
      model: defaults.huggingface,
      modelId: deriveModelId('huggingface', defaults.huggingface),
      dimensions: '384',
      prefixes: 'No',
      status: 'Default HuggingFace model. Requires `HUGGINGFACE_API_KEY`.',
      notes: 'Uses the Hugging Face Inference Providers router unless `HUGGINGFACE_ENDPOINT_URL` is set.',
    },
    {
      provider: 'huggingface',
      model: 'nomic-ai/nomic-embed-text-v1.5',
      modelId: deriveModelId('huggingface', 'nomic-ai/nomic-embed-text-v1.5'),
      dimensions: '768 by default; Matryoshka sizes 512, 256, 128, and 64 exist upstream',
      prefixes: `Yes: \`${nomicPrefixes.document}\` for documents, \`${nomicPrefixes.query}\` for queries`,
      status: 'Supported by the generic HuggingFace provider path and the nomic prefix matcher.',
      notes: 'This server does not configure reduced Matryoshka output dimensions, so use a separate model id/index if you add such support later.',
    },
    {
      provider: 'fake',
      model: 'any model name',
      modelId: 'Testing-only provider; not part of the production model-id catalogue',
      dimensions: `${defaults.fakeDim} by default; ` +
        `\`KB_FAKE_DIM\` clamps to ${defaults.fakeMinDim}-${defaults.fakeMaxDim}`,
      prefixes: 'No',
      status: 'CI/offline fixtures only. Never use for retrieval quality.',
      notes: 'Deterministic hash-bag embeddings for tests and local fixtures; model name is metadata only.',
    },
  ];

  return `${[
    '# Embedding Model Compatibility',
    '',
    '<!-- This file is generated by scripts/generate-embedding-models-reference.mjs. Do not edit by hand. -->',
    '',
    'This reference lists the embedding-provider/model combinations that the repo names, defaults, tests, or documents directly.',
    'The provider adapters can accept other provider-specific model names, but those are operator-validated extensions: confirm vector dimension, context window, task-prefix requirements, and index rebuild impact before sharing the resulting model id.',
    '',
    'Generated source of truth:',
    '',
    '- Provider defaults and accepted providers: `src/config/provider.ts`.',
    '- Task-prefix behavior: `src/embedding-provider.ts`.',
    '- Paid-provider cost tiers: `src/cost-estimates.ts`.',
    `- External dimension/context references: ${MODEL_DOC_SOURCES.join('; ')}.`,
    '',
    'Run `npm run docs:generate-embedding-models` after changing any of those source values. The `docs:check-embedding-models` gate fails if this file drifts.',
    '',
    '## Compatibility Matrix',
    '',
    '| Provider | Model name | Model id | Vector dimensions | Task prefixes | Repo status | Switch-over notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => [
      row.provider,
      code(row.model),
      code(row.modelId),
      row.dimensions,
      row.prefixes,
      row.status,
      row.notes,
    ].map(markdownTableCell).join(' | ')).map((line) => `| ${line} |`),
    '',
    '## Reindex Rules',
    '',
    '- Changing provider, model name, output dimension, or task-prefix behavior creates a different vector space. Build or refresh the target model index before switching active traffic to it.',
    '- `model_id` is derived from `(provider, model_name)` as typed. Tags and slashes are normalized for the filesystem, but semantically equivalent names are not canonicalized.',
    '- Nomic-family models require role-specific task prefixes while `KB_EMBEDDING_TASK_PREFIXES` is enabled. Indexes built before that behavior need a reindex before prefixed queries are comparable.',
    '- FAISS indexes are dimension-specific. Do not point an existing model directory at a model with a different output dimension.',
    '- For paid providers, run `kb models add <provider> <model> --dry-run` first so the CLI prints the estimated token cost before any embedding traffic.',
    '',
    '## Related',
    '',
    '- [Switching embedding models](../operations/switching-embedding-models.md).',
    '- [Configuration reference](configuration.md) for provider environment variables.',
    '- [Index quantization](../operations/index-quantization.md) for SQ8 storage tradeoffs.',
    '- [RFC 013 - multi-model embedding support](../rfcs/013-multimodel-support.md).',
  ].join('\n')}\n`;
}

export async function writeEmbeddingModelsReference({ root = REPO_ROOT } = {}) {
  const target = path.join(root, EMBEDDING_MODELS_REFERENCE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, await generateEmbeddingModelsReferenceMarkdown({ root }), 'utf8');
}

export async function checkEmbeddingModelsReference({ root = REPO_ROOT } = {}) {
  const expected = await generateEmbeddingModelsReferenceMarkdown({ root });
  const target = path.join(root, EMBEDDING_MODELS_REFERENCE_PATH);
  let actual = null;
  try {
    actual = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: actual === expected, exists: actual !== null };
}

async function readSources(root) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(SOURCE_PATHS).map(async ([key, sourcePath]) => [
        key,
        await fs.readFile(path.join(root, sourcePath), 'utf8'),
      ]),
    ),
  );
}

function parseKnownProviders(source) {
  const body = matchString(source, /export const KNOWN_EMBEDDING_PROVIDERS = \[([\s\S]*?)\] as const/, 'KNOWN_EMBEDDING_PROVIDERS');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function matchString(source, regex, label) {
  const match = regex.exec(source);
  if (!match) throw new Error(`Unable to find ${label}`);
  return match[1];
}

function matchNumber(source, regex, label) {
  const raw = matchString(source, regex, label);
  return Number(raw);
}

function assertExactValues(actual, expected, label) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} missing expected value(s): ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    throw new Error(`${label} has undocumented value(s): ${extra.join(', ')}`);
  }
}

async function loadDeriveModelId(root) {
  const builtModuleUrl = pathToFileURL(path.join(root, 'build/model-id.js')).href;
  try {
    const builtModule = await import(builtModuleUrl);
    return builtModule.deriveModelId;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return deriveModelIdFallback;
  }
}

// Keep this fallback byte-equivalent to src/model-id.ts so the generator works
// before `npm run build`; `docs:check-embedding-models` runs after build in
// `npm run check` and exercises the production implementation.
function deriveModelIdFallback(provider, modelName) {
  const slug = modelName
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${provider.toLowerCase()}__${slug}`;
}

function code(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function markdownTableCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

async function main(argv) {
  if (argv.includes('--check')) {
    const { ok, exists } = await checkEmbeddingModelsReference();
    if (!ok) {
      process.stderr.write(
        [
          `${EMBEDDING_MODELS_REFERENCE_PATH} is ${exists ? 'out of date' : 'missing'}.`,
          'Run `npm run docs:generate-embedding-models` and commit the result.',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
    }
    return;
  }
  await writeEmbeddingModelsReference();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`docs:generate-embedding-models: ${err.message}\n`);
    process.exitCode = 1;
  });
}
