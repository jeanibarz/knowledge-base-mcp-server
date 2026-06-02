import type { Document } from '@langchain/core/documents';
import {
  FaissIndexManager,
  type SearchResultDocument,
  type SimilaritySearchTiming,
} from './FaissIndexManager.js';
import { resolveActiveModel } from './active-model.js';
import { buildChunkId, parseChunkReference } from './chunk-id.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KB_EDITOR_URI,
} from './config/retrieval.js';
import {
  formatRetrievalAsJson,
  formatRetrievalAsMarkdown,
} from './formatter.js';
import { classifyKbSearchError, exitCodeForFailure, formatKbSearchFailureJson, formatKbSearchFailureStderr } from './search-errors-core.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';

export const RELATED_HELP = `kb related — find chunks related to an existing result

Usage:
  kb related <chunk-id|kb://uri> [options]

Resolves a public chunk id or kb:// resource URI from an existing search
result, retrieves the seed chunk from the loaded index, and runs dense
similarity search using the seed chunk text. The seed chunk is excluded from
results by default.

Options:
  --k=<int>             Related results to show (default 10).
  --threshold=<float>   Max similarity score; lower = closer match (default 2).
  --kb=<name>           Scope related search to a knowledge base. Defaults to
                        the seed chunk's knowledge base when available.
  --all-kbs             Search across all knowledge bases instead of default
                        seed-KB scoping.
  --format=md|json      Output format (default: md).
  --include-self        Keep the seed chunk in the result set.
  --no-cache            Bypass the query-embedding cache for this search.
  --help, -h            Show this help.

Exit codes:
  0   related search completed
  1   runtime / index error, or no indexed chunk matched the reference
  2   missing / invalid argument, env, or model-resolution error

Examples:
  kb related alpha/docs/deploy.md#L42-L78
  kb related kb://alpha/docs/deploy.md#L42-L78 --format=json
  kb related alpha/docs/deploy.md#L42-L78 --all-kbs --k=5
`;

type RelatedFormat = 'md' | 'json';

export interface RelatedArgs {
  target: string;
  k: number;
  threshold: number;
  format: RelatedFormat;
  includeSelf: boolean;
  noCache: boolean;
  kb?: string;
  allKbs: boolean;
}

export interface RunRelatedDeps {
  bootstrapLayout: typeof FaissIndexManager.bootstrapLayout;
  resolveActiveModel: typeof resolveActiveModel;
  loadManagerForModel: typeof loadManagerForModel;
  loadWithJsonRetry: typeof loadWithJsonRetry;
}

const DEFAULT_RUN_RELATED_DEPS: RunRelatedDeps = {
  bootstrapLayout: FaissIndexManager.bootstrapLayout,
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry,
};

export async function runRelated(
  rest: string[] = [],
  deps: RunRelatedDeps = DEFAULT_RUN_RELATED_DEPS,
): Promise<number> {
  let parsed: RelatedArgs;
  try {
    parsed = parseRelatedArgs(rest);
  } catch (err) {
    process.stderr.write(`kb related: ${(err as Error).message}\n`);
    return 2;
  }

  const reference = parseTarget(parsed.target);
  if ('error' in reference) {
    process.stderr.write(`kb related: ${reference.error}\n`);
    return 2;
  }

  try {
    await deps.bootstrapLayout();
    const activeModelId = await deps.resolveActiveModel({});
    const manager = await deps.loadManagerForModel(activeModelId);
    await deps.loadWithJsonRetry(manager);

    const seed = manager.findChunkByReference(reference.value);
    if (seed === null) {
      process.stderr.write(`kb related: no indexed chunk matched '${parsed.target}'\n`);
      return 1;
    }

    const seedMetadata = seed.metadata as Record<string, unknown>;
    const scopedKb = parsed.allKbs ? undefined : (parsed.kb ?? reference.value.knowledgeBase);
    const fetchK = parsed.includeSelf ? parsed.k : parsed.k + 1;
    const timing: SimilaritySearchTiming = {};
    const rawResults = await manager.similaritySearch(
      seed.pageContent,
      fetchK,
      parsed.threshold,
      scopedKb,
      undefined,
      timing,
      { noCache: parsed.noCache },
    );
    const results = parsed.includeSelf
      ? rawResults.slice(0, parsed.k)
      : excludeSeed(rawResults, seed).slice(0, parsed.k);

    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify({
        schema_version: 'kb.related.v1',
        seed: {
          target: parsed.target,
          chunk_id: buildChunkId(seedMetadata),
          content: seed.pageContent,
          metadata: seedMetadata,
        },
        scoped_kb: scopedKb ?? null,
        include_self: parsed.includeSelf,
        results: formatRetrievalAsJson(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI),
      }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(formatRelatedMarkdown({
      target: parsed.target,
      scopedKb,
      includeSelf: parsed.includeSelf,
      results,
    }));
    return 0;
  } catch (err) {
    const failure = classifyKbSearchError(err);
    if (parsed.format === 'json') {
      process.stdout.write(formatKbSearchFailureJson(failure));
    } else {
      process.stderr.write(formatKbSearchFailureStderr(failure));
    }
    return exitCodeForFailure(failure);
  }
}

export function parseRelatedArgs(rest: string[]): RelatedArgs {
  const out: Omit<RelatedArgs, 'target'> & { target: string | null } = {
    target: null,
    k: 10,
    threshold: 2,
    format: 'md',
    includeSelf: false,
    noCache: false,
    allKbs: false,
  };
  for (const raw of rest) {
    if (raw === '--include-self') { out.includeSelf = true; continue; }
    if (raw === '--no-cache') { out.noCache = true; continue; }
    if (raw === '--all-kbs') { out.allKbs = true; continue; }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n;
      continue;
    }
    if (raw.startsWith('--threshold=')) {
      const n = Number(raw.slice('--threshold='.length));
      if (!Number.isFinite(n)) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v;
      continue;
    }
    if (raw.startsWith('--kb=')) {
      const kb = raw.slice('--kb='.length);
      if (kb.trim() === '') throw new Error('--kb must not be empty');
      out.kb = kb;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.target === null) { out.target = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (out.target === null) {
    throw new Error('missing <chunk-id|kb://uri>');
  }
  if (out.allKbs && out.kb !== undefined) {
    throw new Error('--all-kbs cannot be combined with --kb');
  }
  return out as RelatedArgs;
}

function parseTarget(target: string): { value: ReturnType<typeof parseChunkReference> } | { error: string } {
  try {
    const reference = parseChunkReference(target);
    if (reference.kind === 'path') {
      return { error: 'expected a chunk id or kb:// URI, got a KB-relative path' };
    }
    return { value: reference };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function excludeSeed(
  results: SearchResultDocument[],
  seed: Document,
): SearchResultDocument[] {
  const seedId = buildChunkId(seed.metadata as Record<string, unknown>);
  if (seedId === null) return results;
  return results.filter((result) => (
    buildChunkId(result.metadata as Record<string, unknown>) !== seedId
  ));
}

function formatRelatedMarkdown(input: {
  target: string;
  scopedKb: string | undefined;
  includeSelf: boolean;
  results: SearchResultDocument[];
}): string {
  const body = formatRetrievalAsMarkdown(
    input.results,
    FRONTMATTER_EXTRAS_WIRE_VISIBLE,
    KB_EDITOR_URI,
  ).replace(/^## Semantic Search Results/, '## Related Results');
  const scope = input.scopedKb === undefined ? 'all' : input.scopedKb;
  const self = input.includeSelf ? 'included' : 'excluded';
  return `Seed: ${input.target}\nScope: ${scope}\nSelf: ${self}\n\n${body}\n`;
}
