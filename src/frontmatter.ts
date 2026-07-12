import yaml from 'js-yaml';

const FRONTMATTER_MAX_BYTES = 8192;

/**
 * Result of parsing YAML frontmatter.
 *
 * `tags` is pre-coerced to a `string[]` for back-compat with RFC 010 M1
 * callers that only consume tags. `frontmatter` carries the whole parsed
 * object - always an object (`{}` on no-frontmatter / malformed / oversized).
 * The raw shape of `frontmatter.tags` is preserved (string or string array)
 * so downstream consumers that want the unprocessed form can read it there.
 * Values are FAILSAFE-parsed, so scalars arrive as strings; `!!js/*` tags
 * are rejected at the YAML level.
 */
export interface ParsedFrontmatter {
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Parses YAML frontmatter bounded at `---` delimiters. Returns extracted
 * `tags` (array or scalar-coerced), the `body` with frontmatter stripped,
 * and the full parsed `frontmatter` object (or `{}` on any failure mode).
 * Never throws: malformed YAML, oversized frontmatter, or no fence all
 * degrade to `{ tags: [], body: content, frontmatter: {} }`.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (typeof content !== 'string' || content.length === 0) {
    return { tags: [], body: content, frontmatter: {} };
  }

  // Opening fence must be `---\n` (or `---\r\n`) at byte 0.
  const openMatch = content.match(/^---\r?\n/);
  if (!openMatch) {
    return { tags: [], body: content, frontmatter: {} };
  }
  const openEnd = openMatch[0].length;

  // Search for the closing fence within the size cap. The closing fence
  // `---` must sit at the start of a line - either at position 0 of the
  // slice (empty frontmatter: `---\n---\n`) or right after a `\n`.
  const searchLimit = Math.min(content.length, FRONTMATTER_MAX_BYTES);
  const searchSlice = content.slice(openEnd, searchLimit);
  const closeMatch = searchSlice.match(/(^|\n)---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { tags: [], body: content, frontmatter: {} };
  }
  const leadNL = closeMatch[1]; // '' or '\n'
  // YAML ends at matchStart when there is a leading `\n` (the `\n` is part
  // of the fence, not the YAML). With no leading `\n` the match sits at
  // position 0, so YAML is empty.
  const yamlEnd = leadNL === '\n' ? closeMatch.index : 0;
  const fenceEnd = closeMatch.index + closeMatch[0].length;
  const yamlRaw = searchSlice.slice(0, yamlEnd);
  const body = content.slice(openEnd + fenceEnd);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlRaw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return { tags: [], body: content, frontmatter: {} };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tags: [], body, frontmatter: {} };
  }

  const parsedObject = parsed as Record<string, unknown>;
  const raw = parsedObject.tags;
  let tags: string[] = [];
  if (Array.isArray(raw)) {
    tags = raw
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) tags = [trimmed];
  }
  return { tags, body, frontmatter: parsedObject };
}

/**
 * Strict frontmatter parse used by mutation paths.
 *
 * The ingestion parser above deliberately degrades malformed YAML to an
 * empty object so one bad note cannot abort a refresh. A writer needs the
 * opposite contract: malformed or structurally invalid frontmatter must be
 * rejected before it can be rewritten.
 */
export interface StrictParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFence: boolean;
}

export interface FrontmatterRewriteResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  body: string;
  newContent: string;
}

export function parseFrontmatterStrict(content: string): StrictParsedFrontmatter {
  if (typeof content !== 'string') {
    throw new Error('malformed frontmatter: note content must be text');
  }

  const openMatch = content.match(/^---\r?\n/);
  if (!openMatch) {
    return { frontmatter: {}, body: content, hasFence: false };
  }

  const openEnd = openMatch[0].length;
  const searchLimit = Math.min(content.length, FRONTMATTER_MAX_BYTES);
  const searchSlice = content.slice(openEnd, searchLimit);
  const closeMatch = searchSlice.match(/(^|\n)---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new Error('malformed frontmatter: missing closing "---" fence');
  }

  const leadNL = closeMatch[1];
  const yamlEnd = leadNL === '\n' ? closeMatch.index : 0;
  const fenceEnd = closeMatch.index + closeMatch[0].length;
  const yamlRaw = searchSlice.slice(0, yamlEnd);
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlRaw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch (error) {
    throw new Error(`malformed frontmatter: ${(error as Error).message}`);
  }

  if (parsed === undefined) parsed = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed frontmatter: expected a YAML mapping');
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body: content.slice(openEnd + fenceEnd),
    hasFence: true,
  };
}

/**
 * Parse, update, serialize, and re-parse one note's frontmatter.
 *
 * Re-parsing the generated document is intentional: mutation callers get a
 * validated write payload and a proof that the body boundary survived the
 * serialization step before they hand it to an atomic writer.
 */
export function rewriteFrontmatter(
  content: string,
  update: (frontmatter: Record<string, unknown>) => Record<string, unknown>,
): FrontmatterRewriteResult {
  const parsed = parseFrontmatterStrict(content);
  const before = { ...parsed.frontmatter };
  const after = update({ ...before });
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    throw new Error('invalid frontmatter rewrite: expected a YAML mapping');
  }

  const newContent = serializeFrontmatter(after, parsed.body);
  const validated = parseFrontmatterStrict(newContent);
  if (validated.body !== parsed.body) {
    throw new Error('invalid frontmatter rewrite: note body changed unexpectedly');
  }

  return { before, after, body: parsed.body, newContent };
}

function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const dumped = yaml.dump(frontmatter, {
    sortKeys: false,
    lineWidth: 0,
    noRefs: true,
  });
  return `---\n${dumped}---\n${body}`;
}
