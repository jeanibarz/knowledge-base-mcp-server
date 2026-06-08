import * as crypto from 'crypto';
import * as path from 'path';
import { Document } from '@langchain/core/documents';

export const RETRIEVAL_VIEW_SCHEMA_VERSION = 'kb.retrieval-view.v1';
export const KB_RETRIEVAL_VIEWS_ENV = 'KB_RETRIEVAL_VIEWS';

export type RetrievalViewKind = 'passage' | 'section' | 'metadata' | 'summary';

export const RETRIEVAL_VIEW_KINDS: readonly RetrievalViewKind[] = [
  'passage',
  'section',
  'metadata',
  'summary',
];

const EXTRA_VIEW_KINDS: readonly Exclude<RetrievalViewKind, 'passage'>[] = ['section', 'metadata', 'summary'];

export interface RetrievalViewMetadata {
  schema_version: typeof RETRIEVAL_VIEW_SCHEMA_VERSION;
  kind: RetrievalViewKind;
  view_id: string;
  canonical_id: string;
  canonical_source: string;
  canonical_chunk_index: number;
  text_hash: string;
  parent?: RetrievalViewParentContext;
}

export interface RetrievalViewParentContext {
  source_title?: string;
  section_title?: string;
  relative_path?: string;
  summary?: string;
}

export interface RetrievalViewHitDiagnostic {
  view: RetrievalViewKind;
  rank: number;
  score: number;
}

export interface RetrievalViewCollapseMetadata {
  schema_version: typeof RETRIEVAL_VIEW_SCHEMA_VERSION;
  canonical_id: string;
  hit_count: number;
  hits: RetrievalViewHitDiagnostic[];
  zoom_out?: RetrievalViewParentContext;
}

export interface RetrievalViewCollapseOptions {
  scoreDirection?: 'lower' | 'higher';
}

export function parseRetrievalViews(raw: string | undefined): RetrievalViewKind[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'off' || trimmed === 'none') return [];
  if (trimmed === 'all') return [...RETRIEVAL_VIEW_KINDS];

  const out: RetrievalViewKind[] = [];
  const seen = new Set<RetrievalViewKind>();
  for (const part of trimmed.split(',')) {
    const value = part.trim().toLowerCase();
    if (value === '') continue;
    if (!isRetrievalViewKind(value)) {
      throw new Error(
        `invalid retrieval view "${part}" (expected ${RETRIEVAL_VIEW_KINDS.join(', ')}, all, none, or off)`,
      );
    }
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

export function resolveRetrievalViews(env: NodeJS.ProcessEnv = process.env): RetrievalViewKind[] {
  return parseRetrievalViews(env[KB_RETRIEVAL_VIEWS_ENV]);
}

export function formatRetrievalViews(views: readonly RetrievalViewKind[]): string {
  return views.join(',');
}

export function isRetrievalViewDocument(doc: Pick<Document, 'metadata'>): boolean {
  return readRetrievalViewMetadata(doc.metadata as Record<string, unknown> | undefined) !== null;
}

export function readRetrievalViewMetadata(
  metadata: Record<string, unknown> | undefined,
): RetrievalViewMetadata | null {
  if (metadata === undefined) return null;
  const raw = metadata.retrieval_view;
  if (!isRecord(raw)) return null;
  if (raw.schema_version !== RETRIEVAL_VIEW_SCHEMA_VERSION) return null;
  if (typeof raw.kind !== 'string' || !isRetrievalViewKind(raw.kind)) return null;
  if (
    typeof raw.view_id !== 'string' ||
    typeof raw.canonical_id !== 'string' ||
    typeof raw.canonical_source !== 'string' ||
    typeof raw.canonical_chunk_index !== 'number' ||
    !Number.isSafeInteger(raw.canonical_chunk_index) ||
    typeof raw.text_hash !== 'string'
  ) {
    return null;
  }
  return raw as unknown as RetrievalViewMetadata;
}

export function retrievalViewText(doc: Pick<Document, 'metadata'>): string | null {
  const raw = (doc.metadata as Record<string, unknown> | undefined)?.retrieval_view_text;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

export function canonicalRetrievalId(metadata: Record<string, unknown>): string {
  const view = readRetrievalViewMetadata(metadata);
  if (view !== null) return view.canonical_id;
  const source = typeof metadata.source === 'string' ? metadata.source : null;
  const chunkIndex = typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : null;
  if (source !== null && chunkIndex !== null) return `${source}#${chunkIndex}`;
  return `meta:${JSON.stringify(metadata)}`;
}

export function buildRetrievalViewDocuments(
  canonicalDocuments: readonly Document[],
  views: readonly RetrievalViewKind[] = resolveRetrievalViews(),
): Document[] {
  if (canonicalDocuments.length === 0 || views.length === 0) {
    return [...canonicalDocuments];
  }

  const requested = new Set(views);
  const out = [...canonicalDocuments];
  for (const doc of canonicalDocuments) {
    const metadata = doc.metadata as Record<string, unknown>;
    const source = typeof metadata.source === 'string' ? metadata.source : '';
    const chunkIndex = typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : -1;
    if (source === '' || chunkIndex < 0) continue;

    const parent = parentContextFor(doc);
    for (const kind of EXTRA_VIEW_KINDS) {
      if (!requested.has(kind)) continue;
      const text = textForView(kind, doc, parent);
      if (text === null) continue;
      out.push(new Document({
        pageContent: doc.pageContent,
        metadata: {
          ...metadata,
          retrieval_view: {
            schema_version: RETRIEVAL_VIEW_SCHEMA_VERSION,
            kind,
            view_id: `${canonicalRetrievalId(metadata)}::${kind}`,
            canonical_id: canonicalRetrievalId(metadata),
            canonical_source: source,
            canonical_chunk_index: chunkIndex,
            text_hash: sha256(text),
            ...(Object.keys(parent).length > 0 ? { parent } : {}),
          } satisfies RetrievalViewMetadata,
          retrieval_view_text: text,
        },
      }));
    }
  }
  return out;
}

export function shouldKeepForRetrievalViews(
  doc: Pick<Document, 'metadata'>,
  views: readonly RetrievalViewKind[] | undefined,
): boolean {
  const view = readRetrievalViewMetadata(doc.metadata as Record<string, unknown> | undefined);
  if (views === undefined || views.length === 0) {
    return view === null;
  }
  const requested = new Set(views);
  if (view === null) return requested.has('passage');
  return requested.has(view.kind);
}

export function collapseRetrievalViewResults<T extends Document & { score?: number }>(
  results: readonly T[],
  options: RetrievalViewCollapseOptions = {},
): T[] {
  if (results.length === 0) return [];
  const scoreDirection = options.scoreDirection ?? 'lower';

  const groups = new Map<string, { representative: T; hits: Array<T & { rank: number; score: number }> }>();
  results.forEach((result, index) => {
    const metadata = result.metadata as Record<string, unknown>;
    const id = canonicalRetrievalId(metadata);
    const score = typeof result.score === 'number' ? result.score : 0;
    const existing = groups.get(id);
    const hit = { ...result, rank: index + 1, score };
    if (existing === undefined) {
      groups.set(id, { representative: result, hits: [hit] });
      return;
    }
    existing.hits.push(hit);
    if (isBetterRepresentative(result, existing.representative)) {
      existing.representative = result;
    }
  });

  const collapsed: T[] = [];
  for (const [id, group] of groups) {
    const scores = group.hits.map((hit) => hit.score);
    const bestScore = scoreDirection === 'higher' ? Math.max(...scores) : Math.min(...scores);
    const strengthMultiplier = 1 + Math.min(group.hits.length - 1, 6) * 0.05;
    const strengthenedScore = scoreDirection === 'higher'
      ? bestScore * strengthMultiplier
      : bestScore / strengthMultiplier;
    const sortedHits = [...group.hits].sort((a, b) => a.rank - b.rank);
    const zoomOut = mergeParentContext(sortedHits);
    const metadata = {
      ...(group.representative.metadata as Record<string, unknown>),
      retrieval_view_collapse: {
        schema_version: RETRIEVAL_VIEW_SCHEMA_VERSION,
        canonical_id: id,
        hit_count: sortedHits.length,
        hits: sortedHits.map((hit) => ({
          view: readRetrievalViewMetadata(hit.metadata as Record<string, unknown>)?.kind ?? 'passage',
          rank: hit.rank,
          score: hit.score,
        })),
        ...(zoomOut !== undefined ? { zoom_out: zoomOut } : {}),
      } satisfies RetrievalViewCollapseMetadata,
    };
    collapsed.push({
      ...group.representative,
      metadata,
      score: strengthenedScore,
    });
  }

  collapsed.sort((left, right) => {
    const leftScore = typeof left.score === 'number' ? left.score : Number.POSITIVE_INFINITY;
    const rightScore = typeof right.score === 'number' ? right.score : Number.POSITIVE_INFINITY;
    return scoreDirection === 'higher' ? rightScore - leftScore : leftScore - rightScore;
  });
  return collapsed;
}

function isRetrievalViewKind(value: string): value is RetrievalViewKind {
  return (RETRIEVAL_VIEW_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBetterRepresentative(candidate: Document, current: Document): boolean {
  const candidateIsView = isRetrievalViewDocument(candidate);
  const currentIsView = isRetrievalViewDocument(current);
  if (currentIsView && !candidateIsView) return true;
  return false;
}

function parentContextFor(doc: Document): RetrievalViewParentContext {
  const metadata = doc.metadata as Record<string, unknown>;
  const title = titleFromMetadata(metadata) ?? basenameTitle(metadata);
  const sectionTitle = sectionTitleFromText(doc.pageContent) ?? sectionTitleFromPreface(metadata);
  const summary = summaryFromDoc(doc, title, sectionTitle);
  return {
    ...(title !== undefined ? { source_title: title } : {}),
    ...(sectionTitle !== undefined ? { section_title: sectionTitle } : {}),
    ...(typeof metadata.relativePath === 'string' ? { relative_path: metadata.relativePath } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function textForView(kind: Exclude<RetrievalViewKind, 'passage'>, doc: Document, parent: RetrievalViewParentContext): string | null {
  const metadata = doc.metadata as Record<string, unknown>;
  const preface = typeof metadata.contextual_preface === 'string' ? metadata.contextual_preface : '';
  if (kind === 'metadata') {
    const parts = [
      parent.source_title ? `Title: ${parent.source_title}` : null,
      parent.relative_path ? `Path: ${parent.relative_path}` : null,
      typeof metadata.knowledgeBase === 'string' ? `Knowledge base: ${metadata.knowledgeBase}` : null,
      typeof metadata.extension === 'string' ? `Extension: ${metadata.extension}` : null,
      tagsText(metadata),
      parent.section_title ? `Section: ${parent.section_title}` : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (kind === 'section') {
    const parts = [
      parent.source_title ? `Source: ${parent.source_title}` : null,
      parent.section_title ? `Section: ${parent.section_title}` : null,
      preface !== '' ? preface : null,
      snippet(doc.pageContent, 700),
    ].filter((part): part is string => part !== null && part.trim() !== '');
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  const summary = parent.summary ?? summaryFromDoc(doc, parent.source_title, parent.section_title);
  return summary === undefined ? null : `Summary: ${summary}`;
}

function titleFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const frontmatter = metadata.frontmatter;
  if (!isRecord(frontmatter)) return undefined;
  const title = frontmatter.title;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
}

function basenameTitle(metadata: Record<string, unknown>): string | undefined {
  const raw = typeof metadata.relativePath === 'string'
    ? metadata.relativePath
    : typeof metadata.source === 'string'
      ? metadata.source
      : undefined;
  if (raw === undefined || raw.trim() === '') return undefined;
  return path.basename(raw, path.extname(raw)).replace(/[-_]+/g, ' ');
}

function sectionTitleFromText(text: string): string | undefined {
  const match = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  return match?.[1]?.trim();
}

function sectionTitleFromPreface(metadata: Record<string, unknown>): string | undefined {
  const preface = metadata.contextual_preface;
  if (typeof preface !== 'string') return undefined;
  const match = preface.match(/(?:section|under)\s+"([^"]+)"/i);
  return match?.[1]?.trim();
}

function summaryFromDoc(
  doc: Document,
  title: string | undefined,
  sectionTitle: string | undefined,
): string | undefined {
  const metadata = doc.metadata as Record<string, unknown>;
  const preface = typeof metadata.contextual_preface === 'string' ? metadata.contextual_preface.trim() : '';
  if (preface !== '') return preface;
  const firstSentence = doc.pageContent
    .replace(/^\s{0,3}#{1,6}\s+.+$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .match(/^(.{20,320}?[.!?])(?:\s|$)/)?.[1]
    ?.trim();
  if (firstSentence !== undefined) {
    return [title, sectionTitle, firstSentence].filter(Boolean).join(' - ');
  }
  const fallback = snippet(doc.pageContent, 240);
  return fallback === null ? undefined : [title, sectionTitle, fallback].filter(Boolean).join(' - ');
}

function snippet(text: string, maxChars: number): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trim()}...`;
}

function tagsText(metadata: Record<string, unknown>): string | null {
  const tags = metadata.tags;
  if (!Array.isArray(tags)) return null;
  const values = tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '');
  return values.length > 0 ? `Tags: ${values.join(', ')}` : null;
}

function mergeParentContext(hits: ReadonlyArray<Document>): RetrievalViewParentContext | undefined {
  const out: RetrievalViewParentContext = {};
  for (const hit of hits) {
    const parent = readRetrievalViewMetadata(hit.metadata as Record<string, unknown>)?.parent;
    if (parent === undefined) continue;
    out.source_title ??= parent.source_title;
    out.section_title ??= parent.section_title;
    out.relative_path ??= parent.relative_path;
    out.summary ??= parent.summary;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
