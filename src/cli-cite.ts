// `kb cite` — export bibliography entries from note frontmatter.
//
// This first version is intentionally path-selector only: it resolves the
// same note pointers that `kb open` accepts, parses YAML frontmatter, and
// formats one citation without consulting indexes or live KB services.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseChunkReference } from './chunk-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { KBError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { resolveKbPath } from './kb-fs.js';

export const CITE_HELP = `kb cite — export a bibliography entry from note frontmatter

Usage:
  kb cite <chunk-id|kb://uri|kb-relative-path> [--format=bibtex|csl-json|text]

Reads one markdown note, extracts citation-oriented frontmatter fields, and
prints a ready-to-paste bibliography entry. Accepted selector forms match
\`kb open\`: a chunk id, a kb:// URI, or a KB-relative path such as
\`research/papers/example.md\`. Line or chunk fragments are accepted but only
identify the containing note; citation fields come from note frontmatter.

Recognized frontmatter fields:
  authors, author       String or string array. String values split on
                        " and "; comma splitting is used only for lists of
                        three or more names to avoid breaking "Last, First".
  title                 Citation title.
  published, date       YYYY, YYYY-MM, or YYYY-MM-DD publication date.
  doi                   DOI.
  url                   Canonical URL. If absent and arxiv_id is present,
                        an arXiv abstract URL is emitted.
  arxiv_id              arXiv identifier, emitted as eprint/archive metadata.

Options:
  --format=bibtex|csl-json|text
                        Output format (default: bibtex).
  --help, -h            Show this help.

Environment:
  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.

Exit codes:
  0   citation exported
  1   note path is well-formed but cannot be read
  2   missing / invalid argument, format, selector, or KB name

Examples:
  kb cite arxiv-llm-inference/papers/recurrent-transformer.md
  kb cite kb://research/papers/example.md --format=csl-json
  kb cite research/papers/example.md#L12-L48 --format=text
`;

export type CiteFormat = 'bibtex' | 'csl-json' | 'text';

export interface CiteArgs {
  target: string;
  format: CiteFormat;
}

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

export interface RunCiteDeps {
  rootDir: string;
  readFile: (filePath: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function defaultCiteDeps(): RunCiteDeps {
  return {
    rootDir: KNOWLEDGE_BASES_ROOT_DIR,
    readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export async function runCite(
  rest: string[] = [],
  deps: RunCiteDeps = defaultCiteDeps(),
): Promise<number> {
  let args: CiteArgs;
  try {
    args = parseCiteArgs(rest);
  } catch (err) {
    deps.stderr(`kb cite: ${(err as Error).message}\n`);
    return 2;
  }

  let reference: ReturnType<typeof parseChunkReference>;
  try {
    reference = parseChunkReference(args.target);
  } catch (err) {
    deps.stderr(`kb cite: ${(err as Error).message}\n`);
    return 2;
  }

  let absolutePath: string;
  try {
    absolutePath = await resolveKbPath(
      deps.rootDir,
      reference.knowledgeBase,
      reference.kbRelativePath,
      { mustExist: true },
    );
  } catch (err) {
    deps.stderr(`kb cite: ${(err as Error).message}\n`);
    return exitCodeForResolveError(err);
  }

  let content: string;
  try {
    content = await deps.readFile(absolutePath);
  } catch (err) {
    deps.stderr(`kb cite: failed to read ${reference.displayPath}: ${(err as Error).message}\n`);
    return 1;
  }

  const parsed = parseFrontmatter(content);
  const entry = citationEntryFromFrontmatter(parsed.frontmatter, reference.displayPath);
  deps.stdout(`${formatCitation(entry, args.format)}\n`);
  return 0;
}

export function parseCiteArgs(rest: readonly string[]): CiteArgs {
  const out: { target: string | null; format: CiteFormat } = {
    target: null,
    format: 'bibtex',
  };
  for (const raw of rest) {
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (!isCiteFormat(value)) throw new Error(`invalid --format: ${raw}`);
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.target !== null) throw new Error(`unexpected argument: ${raw}`);
    out.target = raw;
  }
  if (out.target === null) {
    throw new Error('missing <chunk-id|kb://uri|kb-relative-path>');
  }
  return out as CiteArgs;
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
  if (/\s+and\s+/i.test(trimmed)) {
    return trimmed.split(/\s+and\s+/i).map(collapseWhitespace).filter((entry) => entry.length > 0);
  }
  const commaParts = trimmed.split(',').map(collapseWhitespace).filter((entry) => entry.length > 0);
  if (commaParts.length >= 3) return commaParts;
  return [trimmed];
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

function isCiteFormat(value: string): value is CiteFormat {
  return value === 'bibtex' || value === 'csl-json' || value === 'text';
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
    .replace(/[\u0300-\u036f]/g, '')
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

function exitCodeForResolveError(err: unknown): number {
  if (err instanceof KBError) {
    return err.code === 'VALIDATION' || err.code === 'KB_NOT_FOUND' ? 2 : 1;
  }
  return 1;
}
