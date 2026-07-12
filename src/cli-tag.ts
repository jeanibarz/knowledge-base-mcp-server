// kb tag — safe single-note tag mutation (issue #833).
//
// The command follows the retrieval-reference selector used by kb open and
// kb cite, previews by default, and only rewrites one note after --yes.
// The pure update goes through the strict frontmatter rewrite helper so a
// malformed source or an invalid generated document is rejected before the
// atomic writer is reached.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseChunkReference } from './chunk-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { KBError } from './errors.js';
import { rewriteFileAtomically } from './file-mutation.js';
import { rewriteFrontmatter } from './frontmatter.js';
import { resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';

const CODE_TICK = String.fromCharCode(96);

export const TAG_HELP = [
  'kb tag — add or remove frontmatter tags on one note',
  '',
  'Usage:',
  '  kb tag <chunk-id|kb://uri|kb-relative-path>',
  '          [--add=<tag>] [--remove=<tag>] [--format=md|json] [--yes]',
  '',
  'The selector uses the same forms as kb open: a KB-prefixed note path,',
  'kb:// URI, or chunk id. A line/chunk fragment identifies the note but is',
  'not part of the file path. Multiple --add and --remove flags are allowed.',
  '',
  'Default behavior is a dry-run: the proposed before/after tag set is printed',
  'and the note is left byte-identical. Pass --yes to apply the change through',
  'the durable atomic write path. Adding and removing the same tag in one call',
  'is deterministic: removal wins.',
  '',
  'Notes:',
  '  Tagging updates the note immediately; search indexes see the new tags after',
  '  a later kb search --refresh. The kb tags facet reads note files directly.',
  '',
  'Options:',
  '  --add=<tag>             Add a tag (repeatable). Existing order is kept.',
  '  --remove=<tag>          Remove a tag (repeatable).',
  '  --format=md|json        Output format (default: md).',
  '  --yes                   Required to write; without it the command is a dry-run.',
  '  --help, -h              Show this help.',
  '',
  'Environment:',
  '  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.',
  '',
  'Exit codes:',
  '  0   preview or mutation completed',
  '  1   note, frontmatter, or write-policy error',
  '  2   invalid selector or command arguments',
  '',
  'Examples:',
  '  kb tag work/runbooks/deploy.md --add=rollback',
  '  kb tag kb://work/runbooks/deploy.md --remove=stale --yes',
  '  kb tag work/runbooks/deploy.md#L12-L24 --add=verified --format=json --yes',
  '',
].join('\n');

export const TAG_SCHEMA_VERSION = 'kb.tag.v1';

export interface TagArgs {
  target: string;
  add: string[];
  remove: string[];
  format: 'md' | 'json';
  yes: boolean;
}

export interface TagUpdates {
  add: readonly string[];
  remove: readonly string[];
}

export interface TagRewriteResult {
  before: string[];
  after: string[];
  changed: boolean;
  newContent: string;
}

export interface TagNoteOptions extends TagUpdates {
  rootDir: string;
  target: string;
  apply: boolean;
}

export interface TagNoteResult {
  schemaVersion: typeof TAG_SCHEMA_VERSION;
  target: string;
  knowledgeBase: string;
  relativePath: string;
  applied: boolean;
  changed: boolean;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

export function parseTagArgs(rest: readonly string[]): TagArgs {
  let target: string | undefined;
  const add: string[] = [];
  const remove: string[] = [];
  let format: 'md' | 'json' = 'md';
  let yes = false;

  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index];
    if (raw === '--yes') {
      yes = true;
      continue;
    }
    if (raw === '--add' || raw === '--remove') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(raw + ' requires a non-empty value');
      }
      (raw === '--add' ? add : remove).push(parseTagValue(value, raw));
      index += 1;
      continue;
    }
    if (raw.startsWith('--add=')) {
      add.push(parseTagValue(raw.slice('--add='.length), '--add'));
      continue;
    }
    if (raw.startsWith('--remove=')) {
      remove.push(parseTagValue(raw.slice('--remove='.length), '--remove'));
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error('invalid --format: ' + raw);
      }
      format = value;
      continue;
    }
    if (raw.startsWith('--')) {
      throw new Error('unknown flag: ' + raw);
    }
    if (target !== undefined) {
      throw new Error('unexpected argument: ' + JSON.stringify(raw));
    }
    target = raw;
  }

  if (target === undefined) {
    throw new Error('missing <chunk-id|kb://uri|kb-relative-path>');
  }
  if (add.length === 0 && remove.length === 0) {
    throw new Error('at least one of --add or --remove is required');
  }
  return { target, add, remove, format, yes };
}

function parseTagValue(raw: string, flag: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(flag + ' requires a non-empty value');
  }
  if (value.includes('\0')) {
    throw new Error(flag + ' value contains a null byte');
  }
  return value;
}

/**
 * Pure tag-set update. Existing tags are normalized to a stable unique array;
 * additions preserve existing order and removals are applied last.
 */
export function applyTagUpdates(
  originalContent: string,
  updates: TagUpdates,
): TagRewriteResult {
  const add = normalizeRequestedTags(updates.add, '--add');
  const remove = normalizeRequestedTags(updates.remove, '--remove');
  const rewrite = rewriteFrontmatter(originalContent, (frontmatter) => {
    const hasTags = Object.prototype.hasOwnProperty.call(frontmatter, 'tags');
    const current = readExistingTags(frontmatter, hasTags);
    const next = [...current];

    for (const tag of add) {
      if (!next.includes(tag)) next.push(tag);
    }
    for (const tag of remove) {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index] === tag) next.splice(index, 1);
      }
    }

    // Removing an absent tag from a note without a tags key is a true no-op;
    // do not introduce an empty tags array merely to preview a removal.
    if (!hasTags && next.length === 0) return frontmatter;
    return { ...frontmatter, tags: next };
  });

  const before = readExistingTags(
    rewrite.before,
    Object.prototype.hasOwnProperty.call(rewrite.before, 'tags'),
  );
  const after = readExistingTags(
    rewrite.after,
    Object.prototype.hasOwnProperty.call(rewrite.after, 'tags'),
  );
  return {
    before,
    after,
    changed: !sameTags(before, after),
    newContent: rewrite.newContent,
  };
}

function normalizeRequestedTags(values: readonly string[], flag: string): string[] {
  const normalized: string[] = [];
  for (const raw of values) {
    const value = parseTagValue(raw, flag);
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function readExistingTags(
  frontmatter: Record<string, unknown>,
  hasTags: boolean,
): string[] {
  if (!hasTags) return [];
  const raw = frontmatter.tags;
  const values = typeof raw === 'string'
    ? [raw]
    : Array.isArray(raw)
      ? raw
      : null;
  if (values === null || !values.every((value): value is string => typeof value === 'string')) {
    throw new Error('invalid frontmatter tags: expected a string or array of strings');
  }

  const normalized: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (value.length === 0) {
      throw new Error('invalid frontmatter tags: values must not be empty');
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

export async function tagNote(opts: TagNoteOptions): Promise<TagNoteResult> {
  const reference = parseChunkReference(opts.target);
  assertTagTargetIsNote(reference.kbRelativePath);
  const documentPath = await resolveKbPath(
    opts.rootDir,
    reference.knowledgeBase,
    reference.kbRelativePath,
    { mustExist: true },
  );
  const stat = await fsp.stat(documentPath);
  if (!stat.isFile()) {
    throw new Error('tag target is not a file: ' + JSON.stringify(reference.displayPath));
  }

  const kbDir = await resolveKnowledgeBaseDir(opts.rootDir, reference.knowledgeBase);
  const policyKbDir = await fsp.realpath(kbDir);
  const original = await fsp.readFile(documentPath, 'utf-8');
  let mutation = applyTagUpdates(original, opts);
  if (opts.apply && mutation.changed) {
    // Preview reads once for the response; the atomic writer re-reads under
    // its mutation lock so concurrent edits are transformed from current data.
    await rewriteFileAtomically(
      documentPath,
      (current) => {
        mutation = applyTagUpdates(current, opts);
        return mutation.newContent;
      },
      { kbDir: policyKbDir },
    );
  }

  const relativePath = reference.kbRelativePath.replace(/\\/g, '/');
  return {
    schemaVersion: TAG_SCHEMA_VERSION,
    target: opts.target,
    knowledgeBase: reference.knowledgeBase,
    relativePath,
    applied: opts.apply && mutation.changed,
    changed: mutation.changed,
    before: mutation.before,
    after: mutation.after,
    added: mutation.after.filter((tag) => !mutation.before.includes(tag)),
    removed: mutation.before.filter((tag) => !mutation.after.includes(tag)),
  };
}

function assertTagTargetIsNote(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
    throw new KBError('VALIDATION', 'tag target must be a visible Markdown note');
  }
  const extension = path.posix.extname(normalized).toLowerCase();
  if (extension !== '.md' && extension !== '.markdown') {
    throw new KBError('VALIDATION', 'tag target must be a Markdown note (.md or .markdown)');
  }
}

export function formatTagMarkdown(result: TagNoteResult): string {
  const state = result.applied ? 'applied' : result.changed ? 'dry-run' : 'no-op';
  const location = result.knowledgeBase + '/' + result.relativePath;
  const fence = CODE_TICK.repeat(3);
  const lines = [
    '## Tag — ' + CODE_TICK + location + CODE_TICK + ' (' + state + ')',
    '',
    'Target: ' + CODE_TICK + result.target + CODE_TICK,
    'Added: ' + (result.added.length > 0 ? result.added.join(', ') : 'none'),
    'Removed: ' + (result.removed.length > 0 ? result.removed.join(', ') : 'none'),
    '',
    'Before tags:',
    fence + 'json',
    JSON.stringify(result.before, null, 2),
    fence,
    '',
    'After tags:',
    fence + 'json',
    JSON.stringify(result.after, null, 2),
    fence,
  ];
  if (!result.applied && result.changed) {
    lines.push('', '_Dry-run: re-run with --yes to write._');
  }
  return lines.join('\n') + '\n';
}

export function formatTagJson(result: TagNoteResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}

export async function runTag(rest: string[] = []): Promise<number> {
  let args: TagArgs;
  try {
    args = parseTagArgs(rest);
  } catch (err) {
    process.stderr.write('kb tag: ' + (err as Error).message + '\n');
    return 2;
  }

  try {
    parseChunkReference(args.target);
  } catch (err) {
    process.stderr.write('kb tag: ' + (err as Error).message + '\n');
    return 2;
  }

  try {
    const result = await tagNote({
      rootDir: KNOWLEDGE_BASES_ROOT_DIR,
      target: args.target,
      add: args.add,
      remove: args.remove,
      apply: args.yes,
    });
    process.stdout.write(
      args.format === 'json' ? formatTagJson(result) : formatTagMarkdown(result),
    );
    return 0;
  } catch (err) {
    process.stderr.write('kb tag: ' + (err as Error).message + '\n');
    return isTagInputError(err) ? 2 : 1;
  }
}

function isTagInputError(err: unknown): boolean {
  if (!(err instanceof KBError)) return false;
  if (err.code === 'KB_NOT_FOUND') return true;
  return err.code === 'VALIDATION' && !err.message.startsWith('invalid KB write policy at ');
}
