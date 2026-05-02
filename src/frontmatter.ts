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
