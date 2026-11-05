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
  formatCitations,
  isCiteFormat,
  resolveCitationEntries,
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
  formatCitations,
  isCiteFormat,
  normalizeAuthors,
  resolveCitationEntry,
  resolveCitationEntries,
  type CitationEntry,
  type CitationResolutionDeps,
  type CiteFormat,
} from './citation-core.js';

export const CITE_HELP = `kb cite — export a bibliography from note frontmatter

Usage:
  kb cite <selector> [<selector> ...] [--format=bibtex|csl-json|text|ris]

Reads one or more markdown notes, extracts citation-oriented frontmatter
fields, and prints a ready-to-paste bibliography. Accepted selector forms match
\`kb open\`: a chunk id, a kb:// URI, or a KB-relative path such as
\`research/papers/example.md\`. Line or chunk fragments are accepted but only
identify the containing note; citation fields come from note frontmatter.

Pass several selectors to emit ONE merged bibliography: BibTeX entries and RIS
records are concatenated (deduped by cite key), CSL-JSON becomes a single
combined array, and text prints one line per note. Selectors resolve in order
and the command is all-or-nothing — the first selector that fails to resolve
determines the exit code and no partial output is written.

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
  kb cite research/papers/a.md research/papers/b.md --format=bibtex
`;

export interface CiteArgs {
  targets: string[];
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

  let entries: CitationEntry[];
  try {
    entries = await resolveCitationEntries(args.targets, {
      rootDir: deps.rootDir,
      readFile: deps.readFile,
    });
  } catch (err) {
    deps.stderr(`kb cite: ${(err as Error).message}\n`);
    // All-or-nothing: resolveCitationEntries throws the first failing selector's
    // error in argument order, so the exit-code mapping is unchanged — a read
    // failure (note path resolved, bytes unreadable) stays exit 1; a malformed
    // selector is promoted to KBError('VALIDATION') by the core, so
    // exitCodeForResolveError maps it (and KB_NOT_FOUND) to 2, keeping the
    // pre-refactor exit-code contract for single and multi-selector calls alike.
    return err instanceof CitationReadError ? 1 : exitCodeForResolveError(err);
  }

  deps.stdout(`${formatCitations(entries, args.format)}\n`);
  return 0;
}

export function parseCiteArgs(rest: readonly string[]): CiteArgs {
  const targets: string[] = [];
  let format: CiteFormat = 'bibtex';
  for (const raw of rest) {
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (!isCiteFormat(value)) throw new Error(`invalid --format: ${raw}`);
      format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    // Every non-flag positional is a selector; one or many are accepted and
    // resolved in argument order into one merged bibliography (#1158).
    targets.push(raw);
  }
  if (targets.length === 0) {
    throw new Error('missing <chunk-id|kb://uri|kb-relative-path>');
  }
  return { targets, format };
}

function exitCodeForResolveError(err: unknown): number {
  if (err instanceof KBError) {
    return err.code === 'VALIDATION' || err.code === 'KB_NOT_FOUND' ? 2 : 1;
  }
  return 1;
}
