#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONFIG_SCHEMA } from '../build/config/schema.js';

export const ENV_EXAMPLE_PATH = '.env.example';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GROUPS = [
  ['Embeddings', /^(?:KNOWLEDGE_BASES_|FAISS_|EMBEDDING_|HUGGINGFACE_|OLLAMA_|OPENAI_|KB_(?:ACTIVE_MODEL|FAKE_DIM|HNSW_|INDEX_TYPE|EMBEDDING_|PROVIDER_))/],
  ['Indexing and ingest', /^(?:INDEXING_|INGEST_|KB_(?:INDEXING_|CHUNK_|MAX_FILE_|MAX_EXTRACTED_|LARGE_FILE_|REFRESH_|INGEST_|SECRET_SCAN_))/],
  ['Caching', /^KB_QUERY_CACHE/],
  ['LLM and contextual retrieval', /^(?:OPENROUTER_|KB_(?:CONTEXTUAL_|RETRIEVAL_VIEWS|LLM_|OPENROUTER_|DECOMPOSE_))/],
  ['Relevance gate', /^KB_(?:RELEVANCE_GATE|DENSE_DEGRADE_|GATE_)/],
  ['Reranking', /^KB_RERANK/],
  ['Retrieval safety and display', /^(?:KB_(?:INJECTION_|SHIELD|EDITOR_URI)|FRONTMATTER_)/],
  ['Logging and metrics', /^(?:LOG_|KB_(?:LOG_|SLOW_QUERY_|METRICS_|FLAT_SEARCH_|MUTATION_AUDIT_|AGE_BUDGET_))/],
  ['Daemon and MCP transport', /^(?:KB_DAEMON_|MCP_|KB_MAX_(?:QUERY|FILTER|GLOB))/],
  ['Index watching', /^(?:REINDEX_|KB_(?:FS_WATCH|INDEX_VERSION_|MIN_FREE_DISK_))/],
  ['MCP descriptions and ask', /^(?:RETRIEVE_KNOWLEDGE_|ASK_KNOWLEDGE_|LIST_|KB_(?:STATS_DESCRIPTION|SEARCH_SNIPPET|MCP_PROMPTS|ASK_))/],
  ['OpenTelemetry', /^(?:KB_OTEL_|OTEL_)/],
];

export function generateEnvExample(schema = CONFIG_SCHEMA) {
  const grouped = new Map(GROUPS.map(([title]) => [title, []]));
  grouped.set('Other', []);

  for (const spec of schema) {
    const group = GROUPS.find(([, pattern]) => pattern.test(spec.name))?.[0] ?? 'Other';
    grouped.get(group).push(spec);
  }

  const lines = [
    '# Generated from CONFIG_SCHEMA by scripts/generate-env-example.mjs.',
    '# Copy this file to .env and adjust only the settings you need.',
    '# Do not commit .env or put real credentials in this template.',
  ];

  for (const [title, specs] of grouped) {
    if (specs.length === 0) continue;
    lines.push('', `# ${title}`, '');
    for (const spec of specs) lines.push(...renderSpec(spec), '');
    lines.pop();
  }

  return `${lines.join('\n')}\n`;
}

export async function writeEnvExample({ root = REPO_ROOT } = {}) {
  await fs.writeFile(path.join(root, ENV_EXAMPLE_PATH), generateEnvExample(), 'utf8');
}

export async function checkEnvExample({ root = REPO_ROOT } = {}) {
  const target = path.join(root, ENV_EXAMPLE_PATH);
  let actual = null;
  try {
    actual = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (actual === generateEnvExample()) return true;

  process.stderr.write([
    `${ENV_EXAMPLE_PATH} is out of date.`,
    'Run `npm run docs:generate-env-example` and commit the result.',
    '',
  ].join('\n'));
  return false;
}

function renderSpec(spec) {
  const secret = spec.kind === 'secret' || spec.secret === true;
  const description = spec.description ?? `${spec.kind} configuration value.`;
  const lines = [`# ${oneLine(description)}`];

  if (secret) {
    lines.push('# Secret: leave empty until configured locally.');
  } else if (spec.default !== undefined) {
    lines.push(`# Default: ${spec.default === '' ? '(empty)' : oneLine(spec.default)}`);
  } else if (spec.docDefault !== undefined) {
    lines.push(`# Default: ${oneLine(spec.docDefault)}`);
  } else {
    lines.push('# Default: (unset)');
  }

  lines.push(`${spec.name}=${secret || spec.default === undefined ? '' : dotenvValue(spec.default)}`);
  return lines;
}

function oneLine(value) {
  return String(value).replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function dotenvValue(value) {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  (check ? checkEnvExample().then((current) => {
    if (!current) process.exitCode = 1;
  }) : writeEnvExample()).catch((err) => {
    process.stderr.write(`docs:${check ? 'check' : 'generate'}-env-example: ${err.message}\n`);
    process.exitCode = 1;
  });
}
