// RFC 012 — `kb open`: resolve a retrieval reference back to its source.
//
// `kb search` prints three kinds of pointer at a retrieved chunk:
//   - a chunk id           alpha/docs/deploy.md#L42-L78
//   - a kb:// resource URI kb://alpha/docs/deploy.md#L42-L78
//   - a KB-relative path   alpha/docs/deploy.md   (metadata.relativePath)
// `kb open` accepts any of the three, validates it against the KB root,
// and prints the absolute filesystem path it resolves to. It is strictly
// read-only: it never launches an editor or touches the FAISS index.
// (Issue #411 — launching an editor is deliberately left to the caller.)

import { buildEditorUri, parseChunkReference } from './chunk-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { KB_EDITOR_URI } from './config/retrieval.js';
import { KBError } from './errors.js';
import { resolveKbPath } from './kb-fs.js';

export const OPEN_HELP = `kb open — resolve a retrieval reference to its source file

Usage:
  kb open <chunk-id|kb://uri|kb-relative-path> [--json]

Resolves any of the three pointers \`kb search\` prints back to the absolute
filesystem path of the source document, validated against the knowledge-
base root. Accepted reference forms:

  chunk id      alpha/docs/deploy.md#L42-L78
  kb:// URI     kb://alpha/docs/deploy.md#L42-L78
  KB path       alpha/docs/deploy.md   (a search result's relativePath)

An \`#L<from>-L<to>\` or \`#chunk-<n>\` fragment is optional; when present the
cited line range is reported by \`--json\`.

Strictly read-only — it never launches an editor or touches the FAISS
index. To open the resolved file, hand the path to your editor, e.g.
\`code -g "$(kb open alpha/docs/deploy.md#L42-L78)"\`.

Options:
  --json        Emit a JSON object: { target, knowledgeBase, relativePath, path, line?, lineEnd?, chunkIndex?, editorUri? }.
  --help, -h    Show this help.

Environment:
  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.
  KB_EDITOR_URI             vscode | cursor | file | none (default none).
                            Adds an \`editorUri\` field to \`--json\` output.

Exit codes:
  0   reference resolved to an existing file
  1   reference is well-formed but the file does not exist
  2   missing / invalid argument, or the reference names an unknown KB

Examples:
  kb open alpha/docs/deploy.md#L42-L78
  kb open kb://alpha/docs/deploy.md --json
  code -g "$(kb open alpha/docs/deploy.md#L42-L78)"
`;

interface OpenArgs {
  target: string;
  json: boolean;
}

function parseOpenArgs(rest: string[]): OpenArgs {
  let target: string | null = null;
  let json = false;
  for (const arg of rest) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option '${arg}'`);
    }
    if (target !== null) {
      throw new Error(`expected exactly one reference (unexpected argument '${arg}')`);
    }
    target = arg;
  }
  if (target === null) {
    throw new Error('missing <chunk-id|kb://uri|kb-relative-path>');
  }
  return { target, json };
}

/**
 * A well-formed reference to a missing file is a runtime error (exit 1) —
 * the pointer is stale. A traversal escape or an unknown KB is an input
 * error (exit 2). `resolveKbPath` raises `KBError` for the input cases and
 * a plain `Error` ("path not found") for the missing-file case.
 */
function exitCodeForResolveError(err: unknown): number {
  if (err instanceof KBError) {
    return err.code === 'VALIDATION' || err.code === 'KB_NOT_FOUND' ? 2 : 1;
  }
  return 1;
}

export async function runOpen(rest: string[] = []): Promise<number> {
  let args: OpenArgs;
  try {
    args = parseOpenArgs(rest);
  } catch (err) {
    process.stderr.write(`kb open: ${(err as Error).message}\n`);
    return 2;
  }

  let reference: ReturnType<typeof parseChunkReference>;
  try {
    reference = parseChunkReference(args.target);
  } catch (err) {
    process.stderr.write(`kb open: ${(err as Error).message}\n`);
    return 2;
  }

  let absolutePath: string;
  try {
    absolutePath = await resolveKbPath(
      KNOWLEDGE_BASES_ROOT_DIR,
      reference.knowledgeBase,
      reference.kbRelativePath,
      { mustExist: true },
    );
  } catch (err) {
    process.stderr.write(`kb open: ${(err as Error).message}\n`);
    return exitCodeForResolveError(err);
  }

  if (args.json) {
    const payload: Record<string, unknown> = {
      target: reference.raw,
      knowledgeBase: reference.knowledgeBase,
      relativePath: reference.displayPath,
      path: absolutePath,
    };
    if (reference.lineFrom !== undefined) {
      payload.line = reference.lineFrom;
      payload.lineEnd = reference.lineTo;
    }
    if (reference.chunkIndex !== undefined) {
      payload.chunkIndex = reference.chunkIndex;
    }
    const editorUri = buildEditorUri({ source: absolutePath }, KB_EDITOR_URI, reference.lineFrom);
    if (editorUri !== null) {
      payload.editorUri = editorUri;
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${absolutePath}\n`);
  return 0;
}
