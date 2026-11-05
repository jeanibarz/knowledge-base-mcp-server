// citation-core.ts — command-independent citation formatting + resolution.
//
// Issue #405 boundary: the reusable core behind `kb cite` lives here, in a
// `*-core` module, so BOTH the CLI adapter (`cli-cite.ts`) and the
// `export_citations` MCP tool (#1153, KnowledgeBaseServer) can share one
// behavior without a non-CLI module importing a `cli-*` adapter. It resolves
// the same note pointers `kb open` accepts, parses YAML frontmatter, and
// formats one citation without consulting indexes or live KB services.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseChunkReference } from './chunk-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { KBError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { resolveKbPath } from './kb-fs.js';

export type CiteFormat = 'bibtex' | 'csl-json' | 'text';

export interface CitationEntry {
  key: string;
  notePath: string;
  title?: string;
  authors: string[];
  published?: string;
  year?: string;
  dateParts?: number[];
  doi?: string;
  url?: string;
  arxivId?: string;
}

// Filesystem/IO dependencies for the index-independent selector→entry core.
// The CLI wraps these with stdout/stderr sinks; the MCP tool uses them alone.
export interface CitationResolutionDeps {
  rootDir: string;
  readFile: (filePath: string) => Promise<string>;
}

// A note whose path resolved but whose bytes could not be read (CLI exit 1).
// Carries the display path so every caller renders the same "failed to read"
// message; thrown by `resolveCitationEntry` so a read failure stays
// distinguishable from a selector/resolution error (which map to other exit
// codes / MCP error codes).
export class CitationReadError extends Error {
  readonly displayPath: string;
  constructor(displayPath: string, cause: unknown) {
    super(`failed to read ${displayPath}: ${(cause as Error).message}`, { cause });
    this.name = 'CitationReadError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.displayPath = displayPath;
  }
}

export function defaultCitationResolutionDeps(): CitationResolutionDeps {
  return {
    rootDir: KNOWLEDGE_BASES_ROOT_DIR,
    readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
  };
}

/**
 * Resolve one selector (chunk id / kb:// URI / KB-relative path) to a
 * {@link CitationEntry}, reusing the exact note-pointer resolution `kb open`
 * accepts. Index- and service-independent: it parses the reference, resolves
 * the note path (`mustExist`), reads the note, parses its YAML frontmatter, and
 * builds the entry. Missing or malformed frontmatter is NOT an error — it
 * degrades to a path-derived key exactly as the CLI does.
 *
 * Throws (so the CLI and the MCP tool share one behavior):
 *  - `KBError('VALIDATION', …)` for a malformed selector — `parseChunkReference`
 *    throws a plain Error, which is promoted so the CLI maps it to exit 2 and
 *    the MCP tool surfaces a VALIDATION code.
 *  - `KBError('VALIDATION' | 'KB_NOT_FOUND', …)` or `Error('path not found: …')`
 *    from `resolveKbPath`.
 *  - {@link CitationReadError} when the resolved note cannot be read.
 */
export async function resolveCitationEntry(
  target: string,
  deps: CitationResolutionDeps = defaultCitationResolutionDeps(),
): Promise<CitationEntry> {
  let reference: ReturnType<typeof parseChunkReference>;
  try {
    reference = parseChunkReference(target);
  } catch (err) {
    throw new KBError('VALIDATION', (err as Error).message);
  }

  const absolutePath = await resolveKbPath(
    deps.rootDir,
    reference.knowledgeBase,
    reference.kbRelativePath,
    { mustExist: true },
  );

  let content: string;
  try {
    content = await deps.readFile(absolutePath);
  } catch (err) {
    throw new CitationReadError(reference.displayPath, err);
  }

  const parsed = parseFrontmatter(content);
  return citationEntryFromFrontmatter(parsed.frontmatter, reference.displayPath);
}

export function citationEntryFromFrontmatter(
  frontmatter: Record<string, unknown>,
  notePath: string,
): CitationEntry {
  const title = optionalString(frontmatter.title);
  const authors = normalizeAuthors(frontmatter.authors ?? frontmatter.author);
  const published = optionalString(frontmatter.published ?? frontmatter.date);
  const dateParts = published === undefined ? undefined : parseDateParts(published);
  const year = dateParts?.[0]?.toString() ?? yearFromString(published);
  const doi = normalizeDoi(optionalString(frontmatter.doi));
  const arxivId = optionalString(frontmatter.arxiv_id ?? frontmatter.arxivId);
  const explicitUrl = optionalString(frontmatter.url);
  const url = explicitUrl ?? (arxivId === undefined ? undefined : `https://arxiv.org/abs/${arxivId}`);
  const key = buildCitationKey({ authors, title, year, arxivId, doi, notePath });

  return {
    key,
    notePath,
    ...(title === undefined ? {} : { title }),
    authors,
    ...(published === undefined ? {} : { published }),
    ...(year === undefined ? {} : { year }),
    ...(dateParts === undefined ? {} : { dateParts }),
    ...(doi === undefined ? {} : { doi }),
    ...(url === undefined ? {} : { url }),
    ...(arxivId === undefined ? {} : { arxivId }),
  };
}

export function formatCitation(entry: CitationEntry, format: CiteFormat): string {
  if (format === 'bibtex') return formatBibTeX(entry);
  if (format === 'csl-json') return JSON.stringify([toCslJson(entry)], null, 2);
  return formatTextCitation(entry);
}

export function normalizeAuthors(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => collapseWhitespace(entry))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value !== 'string') return [];
  const trimmed = collapseWhitespace(value);
  if (trimmed.length === 0) return [];
  if (/\s+and\s+/i.test(trimmed)) {  // NOSONAR typescript:S8786 — whitespace-bounded 'and' test on bounded arg
    return trimmed.split(/\s+and\s+/i).map(collapseWhitespace).filter((entry) => entry.length > 0);  // NOSONAR typescript:S8786 — whitespace-bounded 'and' split on bounded arg
  }
  const commaParts = trimmed.split(',').map(collapseWhitespace).filter((entry) => entry.length > 0);
  if (commaParts.length >= 3) return commaParts;
  return [trimmed];
}

export function isCiteFormat(value: string): value is CiteFormat {
  return value === 'bibtex' || value === 'csl-json' || value === 'text';
}

function formatBibTeX(entry: CitationEntry): string {
  const fields: Array<[string, string]> = [];
  if (entry.authors.length > 0) fields.push(['author', entry.authors.join(' and ')]);
  if (entry.title !== undefined) fields.push(['title', entry.title]);
  if (entry.year !== undefined) fields.push(['year', entry.year]);
  if (entry.doi !== undefined) fields.push(['doi', entry.doi]);
  if (entry.url !== undefined) fields.push(['url', entry.url]);
  if (entry.arxivId !== undefined) {
    fields.push(['eprint', entry.arxivId]);
    fields.push(['archivePrefix', 'arXiv']);
  }
  fields.push(['note', `KB note: ${entry.notePath}`]);

  const body = fields
    .map(([name, value]) => `  ${name} = {${escapeBibTeX(value)}},`)
    .join('\n');
  return `@${entry.doi === undefined ? 'misc' : 'article'}{${entry.key},\n${body}\n}`;
}

function toCslJson(entry: CitationEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.key,
    type: entry.doi === undefined ? 'article' : 'article-journal',
    note: `KB note: ${entry.notePath}`,
  };
  if (entry.title !== undefined) out.title = entry.title;
  if (entry.authors.length > 0) {
    out.author = entry.authors.map((author) => ({ literal: author }));
  }
  if (entry.dateParts !== undefined) out.issued = { 'date-parts': [entry.dateParts] };
  if (entry.doi !== undefined) out.DOI = entry.doi;
  if (entry.url !== undefined) out.URL = entry.url;
  if (entry.arxivId !== undefined) {
    out.archive = 'arXiv';
    out.archive_location = entry.arxivId;
  }
  return out;
}

function formatTextCitation(entry: CitationEntry): string {
  const parts: string[] = [];
  if (entry.authors.length > 0) parts.push(entry.authors.join('; '));
  if (entry.year !== undefined) parts.push(`(${entry.year})`);
  if (entry.title !== undefined) parts.push(entry.title);
  if (entry.doi !== undefined) parts.push(`DOI: ${entry.doi}`);
  if (entry.arxivId !== undefined) parts.push(`arXiv: ${entry.arxivId}`);
  if (entry.url !== undefined) parts.push(entry.url);
  parts.push(`KB note: ${entry.notePath}`);
  return `[${entry.key}] ${parts.join('. ')}`;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = collapseWhitespace(value);
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeDoi(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim();
}

function parseDateParts(value: string): number[] | undefined {
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(value.trim());
  if (match === null) return undefined;
  const parts = [Number(match[1])];
  if (match[2] !== undefined) parts.push(Number(match[2]));
  if (match[3] !== undefined) parts.push(Number(match[3]));
  return parts;
}

function yearFromString(value: string | undefined): string | undefined {
  const match = value?.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match?.[1];
}

function buildCitationKey(input: {
  authors: readonly string[];
  title?: string;
  year?: string;
  arxivId?: string;
  doi?: string;
  notePath: string;
}): string {
  const author = input.authors[0] === undefined ? undefined : authorKeyPart(input.authors[0]);
  const baseName = path.basename(input.notePath, path.extname(input.notePath));
  const fallback = slugPart(input.title) ?? slugPart(baseName) ?? 'note';
  const subject = author ?? fallback;
  const year = input.year ?? 'nd';
  const id = slugPart(input.arxivId) ?? doiKeyPart(input.doi) ?? slugPart(input.title) ?? slugPart(baseName);
  return [subject, year, id].filter((part): part is string => part !== undefined).join('-');
}

function authorKeyPart(author: string): string | undefined {
  const beforeComma = author.split(',')[0]?.trim();
  const source = beforeComma && beforeComma.length > 0 ? beforeComma : author;
  const tokens = source.split(/\s+/).filter((token) => token.length > 0);
  return slugPart(tokens[tokens.length - 1]);
}

function doiKeyPart(doi: string | undefined): string | undefined {
  if (doi === undefined) return undefined;
  const tail = doi.split('/').filter((part) => part.length > 0).pop();
  return slugPart(tail ?? doi);
}

function slugPart(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
  return slug.length === 0 ? undefined : slug;
}

function escapeBibTeX(value: string): string {
  return collapseWhitespace(value).replace(/[\\{}]/g, (match) => `\\${match}`);
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
