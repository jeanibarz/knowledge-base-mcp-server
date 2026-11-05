// `kb cite` — export bibliography entries from note frontmatter.
//
// This adapter is intentionally thin: argument parsing, stdout/stderr wiring,
// and exit-code mapping live here, while the command-independent citation
// resolution + formatting live in `citation-core.ts` so the `export_citations`
// MCP tool (#1153) can reuse the exact same behavior without crossing the
// non-CLI import boundary (#405).

import { KBError } from './errors.js';
import {
  CitationReadError,
  defaultCitationResolutionDeps,
  formatCitation,
  isCiteFormat,
  resolveCitationEntry,
  type CitationEntry,
  type CiteFormat,
} from './citation-core.js';

// Re-export the shared citation surface so existing importers (and the CLI's
// own tests) keep a single entry point, while `citation-core.ts` remains the
// command-independent home the MCP server imports from.
export {
  citationEntryFromFrontmatter,
  CitationReadError,
  defaultCitationResolutionDeps,
  formatCitation,
  isCiteFormat,
  normalizeAuthors,
  resolveCitationEntry,
  type CitationEntry,
  type CitationResolutionDeps,
  type CiteFormat,
} from './citation-core.js';

export const CITE_HELP = `kb cite — export a bibliography entry from note frontmatter

Usage:
  kb cite <chunk-id|kb://uri|kb-relative-path> [--format=bibtex|csl-json|text|ris]

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
  --format=bibtex|csl-json|text|ris
                        Output format (default: bibtex). "ris" emits a RIS
                        record for EndNote/Zotero/Mendeley/RefWorks import.
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

export interface CiteArgs {
  target: string;
  format: CiteFormat;
}

export interface RunCiteDeps {
  rootDir: string;
  readFile: (filePath: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function defaultCiteDeps(): RunCiteDeps {
  return {
    ...defaultCitationResolutionDeps(),
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

  let entry: CitationEntry;
  try {
    entry = await resolveCitationEntry(args.target, {
      rootDir: deps.rootDir,
      readFile: deps.readFile,
    });
  } catch (err) {
    deps.stderr(`kb cite: ${(err as Error).message}\n`);
    // A read failure (note path resolved, bytes unreadable) stays exit 1; a
    // malformed selector is promoted to KBError('VALIDATION') by the core, so
    // exitCodeForResolveError maps it (and KB_NOT_FOUND) to 2, keeping the
    // pre-refactor exit-code contract.
    return err instanceof CitationReadError ? 1 : exitCodeForResolveError(err);
  }

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

function exitCodeForResolveError(err: unknown): number {
  if (err instanceof KBError) {
    return err.code === 'VALIDATION' || err.code === 'KB_NOT_FOUND' ? 2 : 1;
  }
  return 1;
}
