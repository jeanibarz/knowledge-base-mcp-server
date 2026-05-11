// Issue #209 — pure data shape + serializer for `kb explain <query>`.
//
// `cli-explain.ts` collects an `ExplainTrace` from the same retrieval
// primitives `kb search` uses (FaissIndexManager.similaritySearch +
// cli-search-staleness) and hands it to the serializers below. Keeping the
// trace pure makes the markdown + JSON renderers golden-testable without
// touching FAISS, the embedding provider, or the filesystem.
//
// Wire shape is versioned with `EXPLAIN_TRACE_SCHEMA_VERSION` so agents
// that branch on `--format=json` stay decoupled from the markdown layout.

export const EXPLAIN_TRACE_SCHEMA_VERSION = 'kb-explain.v1';

export interface ExplainQueryBlock {
  raw: string;
  lowercased: string;
  char_length: number;
  byte_length: number;
}

export interface ExplainSystemBlock {
  active_model_id: string;
  embedding_provider: string;
  embedding_model: string;
  index_path: string;
  index_binary_path: string | null;
  index_mtime: string | null;
  cli_version: string;
  ingest_extra_extensions: readonly string[];
  ingest_exclude_paths: readonly string[];
}

export interface ExplainEmbeddingBlock {
  /** Provider as resolved by the active-model layer. */
  provider: string;
  model: string;
  /** Optional — set when the retriever exposed an embed-stage timing. */
  embed_latency_ms: number | null;
  /** Embedding vector dimension (from the FAISS docstore). */
  dim: number | null;
}

export interface ExplainCandidate {
  rank: number;
  score: number;
  source: string;
  relative_path: string | null;
  knowledge_base: string | null;
  chunk_index: number | null;
  preview: string;
  in_topk: boolean;
}

export interface ExplainRetrievalBlock {
  k: number;
  near_misses_requested: number;
  fetch_k: number;
  candidates: ExplainCandidate[];
}

export interface ExplainFiltersBlock {
  kb_scope: string | null;
  threshold: number;
  threshold_is_default: boolean;
  excluded_paths: readonly string[];
  extra_extensions: readonly string[];
}

export interface ExplainTimingBlock {
  bootstrap_ms: number | null;
  model_resolution_ms: number | null;
  manager_load_ms: number | null;
  index_load_ms: number | null;
  embed_query_ms: number | null;
  faiss_search_ms: number | null;
  post_filter_ms: number | null;
  staleness_ms: number | null;
  total_ms: number;
}

export interface ExplainFreshnessBlock {
  index_mtime: string | null;
  modified_files: number;
  new_files: number;
}

export interface ExplainTrace {
  schema_version: typeof EXPLAIN_TRACE_SCHEMA_VERSION;
  query: ExplainQueryBlock;
  system: ExplainSystemBlock;
  embedding: ExplainEmbeddingBlock;
  retrieval: ExplainRetrievalBlock;
  filters: ExplainFiltersBlock;
  timing: ExplainTimingBlock;
  freshness: ExplainFreshnessBlock;
  diagnostics: string[];
}

const PREVIEW_LEN = 80;

export function buildQueryBlock(raw: string): ExplainQueryBlock {
  return {
    raw,
    lowercased: raw.toLowerCase(),
    char_length: raw.length,
    byte_length: Buffer.byteLength(raw, 'utf-8'),
  };
}

export function previewFromContent(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_LEN) return flat;
  return `${flat.slice(0, PREVIEW_LEN)}…`;
}

interface ScoredChunkLike {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

export function buildCandidates(
  scored: readonly ScoredChunkLike[],
  k: number,
): ExplainCandidate[] {
  return scored.map((doc, idx) => {
    const md = doc.metadata ?? {};
    const source = stringField(md, 'source') ?? `(unknown source ${idx + 1})`;
    const relativePath = stringField(md, 'relativePath');
    const kb = stringField(md, 'knowledgeBase');
    const chunkIndex = numberField(md, 'chunkIndex');
    return {
      rank: idx + 1,
      score: doc.score,
      source,
      relative_path: relativePath,
      knowledge_base: kb,
      chunk_index: chunkIndex,
      preview: previewFromContent(doc.pageContent),
      in_topk: idx < k,
    };
  });
}

/**
 * Issue #209 — diagnostic suggestions are emitted from a small rule set the
 * trace data already supports. Each rule is independent; suggestions are
 * additive so the operator can see every hint that fires.
 */
export function deriveDiagnostics(trace: Omit<ExplainTrace, 'diagnostics'>): string[] {
  const out: string[] = [];
  const candidates = trace.retrieval.candidates;
  const topK = candidates.filter((c) => c.in_topk);

  if (candidates.length === 0) {
    out.push(
      'No candidates returned. The index may be empty for this scope; run ' +
      '`kb search --refresh` to (re)build it.',
    );
  }

  if (topK.length > 0 && trace.filters.threshold !== Number.POSITIVE_INFINITY) {
    const best = topK[0].score;
    if (best > trace.filters.threshold * 0.85) {
      out.push(
        `Top score (${best.toFixed(3)}) is close to the active threshold ` +
        `(${trace.filters.threshold}). Try \`--threshold=auto\` to pick a ` +
        `knee-based cutoff, or relax \`--threshold=\` for this query.`,
      );
    }
  }

  if (trace.filters.kb_scope === null && topK.length > 0) {
    const kbs = new Set(topK.map((c) => c.knowledge_base ?? '(unknown)'));
    if (kbs.size === 1) {
      const only = [...kbs][0];
      if (only !== '(unknown)') {
        out.push(
          `All top-K candidates came from KB "${only}". Consider scoping ` +
          `with \`--kb=${only}\` so unrelated KBs cannot drown out relevant chunks.`,
        );
      }
    }
  }

  const nearMisses = candidates.filter((c) => !c.in_topk);
  if (nearMisses.length > 0) {
    out.push(
      `${nearMisses.length} near-miss candidate(s) sit just below the k=${trace.retrieval.k} ` +
      `cutoff (rank ${trace.retrieval.k + 1}..${candidates.length}). Inspect them ` +
      `to confirm the cutoff is not hiding the right chunk.`,
    );
  }

  if (trace.system.index_mtime === null) {
    out.push(
      'Index has never been built for this model. Run `kb search --refresh` first.',
    );
  } else if (trace.freshness.modified_files + trace.freshness.new_files > 0) {
    out.push(
      `Index is stale: ${trace.freshness.modified_files} modified, ` +
      `${trace.freshness.new_files} new file(s) since ${trace.system.index_mtime}. ` +
      `Re-run with \`--refresh\` (or \`kb search --refresh\`) to include them.`,
    );
  }

  return out;
}

/**
 * Issue #209 — JSON serializer. Deterministic field order matches the
 * `ExplainTrace` interface; `JSON.stringify` walks own-keys in insertion
 * order, so the trace builder is the single source of truth.
 */
export function formatExplainTraceAsJson(trace: ExplainTrace): string {
  return `${JSON.stringify(trace, null, 2)}\n`;
}

const SECTION_RULE = '---';

export function formatExplainTraceAsMarkdown(trace: ExplainTrace): string {
  const sections: string[] = [
    formatHeader(trace),
    formatQuerySection(trace),
    formatSystemSection(trace),
    formatEmbeddingSection(trace),
    formatRetrievalSection(trace),
    formatFiltersSection(trace),
    formatTimingSection(trace),
    formatFreshnessSection(trace),
    formatDiagnosticsSection(trace),
  ];
  return `${sections.join(`\n\n${SECTION_RULE}\n\n`)}\n`;
}

function formatHeader(trace: ExplainTrace): string {
  return [
    `# kb explain trace`,
    ``,
    `> _schema: ${trace.schema_version}. This is a debug surface — fields may evolve under the schema version._`,
  ].join('\n');
}

function formatQuerySection(trace: ExplainTrace): string {
  const q = trace.query;
  return [
    `## Query`,
    ``,
    `- raw: \`${q.raw}\``,
    `- lowercased: \`${q.lowercased}\``,
    `- char length: ${q.char_length}`,
    `- byte length: ${q.byte_length}`,
  ].join('\n');
}

function formatSystemSection(trace: ExplainTrace): string {
  const s = trace.system;
  return [
    `## System`,
    ``,
    `- active model: \`${s.active_model_id}\``,
    `- embedding: \`${s.embedding_provider}\` / \`${s.embedding_model}\``,
    `- index path: \`${s.index_path}\``,
    `- index binary: ${s.index_binary_path ? `\`${s.index_binary_path}\`` : '_(absent — index not yet built)_'}`,
    `- index mtime: ${s.index_mtime ?? '_(absent)_'}`,
    `- cli version: \`${s.cli_version}\``,
    `- INGEST_EXTRA_EXTENSIONS: ${formatList(s.ingest_extra_extensions)}`,
    `- INGEST_EXCLUDE_PATHS: ${formatList(s.ingest_exclude_paths)}`,
  ].join('\n');
}

function formatEmbeddingSection(trace: ExplainTrace): string {
  const e = trace.embedding;
  return [
    `## Embedding`,
    ``,
    `- provider: \`${e.provider}\``,
    `- model: \`${e.model}\``,
    `- embed latency: ${e.embed_latency_ms === null ? '_(not measured for this path)_' : `${e.embed_latency_ms} ms`}`,
    `- dim: ${e.dim ?? '_(absent — index not yet built)_'}`,
  ].join('\n');
}

function formatRetrievalSection(trace: ExplainTrace): string {
  const r = trace.retrieval;
  const header = [
    `## Retrieval`,
    ``,
    `- k: ${r.k}`,
    `- near-miss candidates requested: ${r.near_misses_requested}`,
    `- effective fetch_k: ${r.fetch_k}`,
    ``,
  ];
  if (r.candidates.length === 0) {
    return [...header, `_No candidates returned._`].join('\n');
  }
  const tableHeader = [
    `| rank | score | in top-k | source | chunk | preview |`,
    `|------|-------|---------|--------|-------|---------|`,
  ];
  const rows = r.candidates.map((c) => {
    const inTopK = c.in_topk ? '✓' : ' ';
    const chunkLabel = c.chunk_index === null ? '—' : `${c.chunk_index}`;
    return `| ${c.rank} | ${c.score.toFixed(3)} | ${inTopK} | \`${c.source}\` | ${chunkLabel} | ${escapeTableCell(c.preview)} |`;
  });
  return [...header, ...tableHeader, ...rows].join('\n');
}

function formatFiltersSection(trace: ExplainTrace): string {
  const f = trace.filters;
  return [
    `## Filters`,
    ``,
    `- KB scope: ${f.kb_scope === null ? '_(all KBs)_' : `\`${f.kb_scope}\``}`,
    `- threshold: ${f.threshold} ${f.threshold_is_default ? '_(default)_' : '_(override)_'}`,
    `- INGEST_EXTRA_EXTENSIONS: ${formatList(f.extra_extensions)}`,
    `- INGEST_EXCLUDE_PATHS: ${formatList(f.excluded_paths)}`,
  ].join('\n');
}

function formatTimingSection(trace: ExplainTrace): string {
  const t = trace.timing;
  const rows: Array<[string, number | null]> = [
    ['bootstrap', t.bootstrap_ms],
    ['model resolution', t.model_resolution_ms],
    ['manager load', t.manager_load_ms],
    ['index load', t.index_load_ms],
    ['embed query', t.embed_query_ms],
    ['faiss search', t.faiss_search_ms],
    ['post filter', t.post_filter_ms],
    ['staleness', t.staleness_ms],
  ];
  const lines = [
    `## Timing`,
    ``,
    ...rows.map(([label, value]) => `- ${label}: ${value === null ? '_(skipped)_' : `${value} ms`}`),
    `- **total: ${t.total_ms} ms**`,
  ];
  return lines.join('\n');
}

function formatFreshnessSection(trace: ExplainTrace): string {
  const f = trace.freshness;
  return [
    `## Freshness`,
    ``,
    `- index mtime: ${f.index_mtime ?? '_(absent — index not yet built)_'}`,
    `- modified file(s) since index: ${f.modified_files}`,
    `- new file(s) since index: ${f.new_files}`,
  ].join('\n');
}

function formatDiagnosticsSection(trace: ExplainTrace): string {
  const header = `## Diagnostic suggestions`;
  if (trace.diagnostics.length === 0) {
    return [header, ``, `_None — nothing flagged for this query._`].join('\n');
  }
  return [header, ``, ...trace.diagnostics.map((d) => `- ${d}`)].join('\n');
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return '_(none)_';
  return items.map((s) => `\`${s}\``).join(', ');
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function stringField(md: Record<string, unknown>, key: string): string | null {
  const v = md[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function numberField(md: Record<string, unknown>, key: string): number | null {
  const v = md[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
