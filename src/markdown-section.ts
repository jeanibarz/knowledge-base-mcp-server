// Heading-aware section splicing for `kb remember --append-section` (#139).
//
// Goal: locate a named heading in a markdown document and append new content
// at the END of that section (after every subsection), then return the new
// document. Headings inside fenced code blocks, HTML comments, and YAML
// frontmatter must NEVER match — that's the whole reason we parse rather
// than regex-walk.

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Heading, Root, Text } from 'mdast';
import { parseFrontmatter } from './frontmatter.js';

export interface HeadingSpec {
  level: number;
  text: string;
}

export interface FoundHeading {
  level: number;
  text: string;
  /** 1-indexed line of the heading in the body (frontmatter excluded). */
  line: number;
}

export interface SpliceResult {
  content: string;
}

/**
 * Parse `--append-section` argument into a {level, text} pair.
 *
 * Input must be `<#{1..6}> <text>` exactly — leading hashes set the level,
 * a single space separator, then the rendered heading text. We require the
 * level prefix so `## Foo` cannot accidentally match `### Foo`.
 */
export function parseHeadingSpec(spec: string): HeadingSpec {
  const match = spec.match(/^(#{1,6})\s+(\S.*?)\s*$/);
  if (!match) {
    throw new Error(
      `--append-section must be of the form "<#..######> <heading text>" (e.g. "## OSS gate"); got ${JSON.stringify(spec)}`,
    );
  }
  return { level: match[1].length, text: match[2] };
}

/**
 * Extract every heading from `body` with its rendered text and 1-indexed
 * line position. mdast handles fenced code blocks, HTML comments, and
 * indented blocks correctly — a `## Foo` inside ``` ... ``` is NOT a heading
 * and never appears in the returned list.
 */
export function listHeadings(body: string): FoundHeading[] {
  const tree: Root = fromMarkdown(body);
  const out: FoundHeading[] = [];
  for (const node of tree.children) {
    if (node.type !== 'heading') continue;
    const heading = node as Heading;
    if (!heading.position) continue;
    out.push({
      level: heading.depth,
      text: renderHeadingText(heading),
      line: heading.position.start.line,
    });
  }
  return out;
}

function renderHeadingText(heading: Heading): string {
  let text = '';
  for (const child of heading.children) {
    if (child.type === 'text' || child.type === 'inlineCode') {
      text += (child as Text).value;
    } else if ('children' in child && Array.isArray(child.children)) {
      // Recursively render emphasis/strong/link children — match what a
      // human would read when scanning the heading.
      for (const nested of child.children) {
        if (nested.type === 'text' || nested.type === 'inlineCode') {
          text += (nested as Text).value;
        }
      }
    }
  }
  return text.trim();
}

/**
 * Result of locating the named section in `body`.
 *
 * `splitLineIndex` is the 0-indexed line of `body.split('\n')` where the
 * next sibling-or-shallower heading begins, or `lines.length` if the section
 * extends to EOF.
 */
export interface LocatedSection {
  /** 1-indexed line of the matched heading in body. */
  headingLine: number;
  /** 0-indexed split point used by spliceAppend. */
  splitLineIndex: number;
}

export interface LocateOptions {
  /** 1-indexed occurrence to pick when multiple headings match. Default: must be unique. */
  occurrence?: number;
}

export class HeadingNotFoundError extends Error {
  readonly available: FoundHeading[];
  constructor(spec: HeadingSpec, available: FoundHeading[]) {
    super(buildNotFoundMessage(spec, available));
    this.name = 'HeadingNotFoundError';
    this.available = available;
  }
}

function buildNotFoundMessage(spec: HeadingSpec, available: FoundHeading[]): string {
  const want = `${'#'.repeat(spec.level)} ${spec.text}`;
  if (available.length === 0) {
    return `--append-section: heading not found: ${JSON.stringify(want)} (file has no headings)`;
  }
  const lines = available.map((h) => `  ${'#'.repeat(h.level)} ${h.text}  (line ${h.line})`);
  return `--append-section: heading not found: ${JSON.stringify(want)}\nAvailable headings:\n${lines.join('\n')}`;
}

export class AmbiguousHeadingError extends Error {
  readonly matches: FoundHeading[];
  constructor(spec: HeadingSpec, matches: FoundHeading[]) {
    const want = `${'#'.repeat(spec.level)} ${spec.text}`;
    const lineList = matches.map((h) => `  line ${h.line}`).join('\n');
    super(
      `--append-section: heading appears ${matches.length} times: ${JSON.stringify(want)}\n${lineList}\nDisambiguate with --occurrence=<N> (1-indexed).`,
    );
    this.name = 'AmbiguousHeadingError';
    this.matches = matches;
  }
}

export class OccurrenceOutOfRangeError extends Error {
  constructor(spec: HeadingSpec, requested: number, available: number) {
    const want = `${'#'.repeat(spec.level)} ${spec.text}`;
    super(
      `--append-section: --occurrence=${requested} out of range for ${JSON.stringify(want)} (file has ${available} match${available === 1 ? '' : 'es'})`,
    );
    this.name = 'OccurrenceOutOfRangeError';
  }
}

/**
 * Locate the named heading in `body` and compute the line-array split point
 * that marks the end of its section.
 */
export function locateSection(body: string, spec: HeadingSpec, opts: LocateOptions = {}): LocatedSection {
  const headings = listHeadings(body);
  const matches = headings.filter((h) => h.level === spec.level && h.text === spec.text);

  if (matches.length === 0) {
    throw new HeadingNotFoundError(spec, headings);
  }

  let chosen: FoundHeading;
  if (opts.occurrence !== undefined) {
    if (opts.occurrence < 1 || opts.occurrence > matches.length) {
      throw new OccurrenceOutOfRangeError(spec, opts.occurrence, matches.length);
    }
    chosen = matches[opts.occurrence - 1];
  } else {
    if (matches.length > 1) {
      throw new AmbiguousHeadingError(spec, matches);
    }
    chosen = matches[0];
  }

  // Find the next heading at the same OR shallower level after `chosen`.
  // That's where this section ends.
  const lineCount = body.split('\n').length;
  let splitLineIndex = lineCount;
  for (const h of headings) {
    if (h.line <= chosen.line) continue;
    if (h.level <= chosen.level) {
      // mdast lines are 1-indexed; split-point is 0-indexed, so we use
      // `h.line - 1` to land the split point on the heading line.
      splitLineIndex = h.line - 1;
      break;
    }
  }
  return { headingLine: chosen.line, splitLineIndex };
}

/**
 * Splice `newContent` into `body` at `splitLineIndex` with exactly one
 * blank line above and one blank line below. Adjacent blank lines on either
 * side of the insertion point are collapsed so repeated appends do not
 * accumulate vertical whitespace.
 *
 * The returned body always ends with a newline — even if the input did not.
 */
export function spliceAppend(body: string, splitLineIndex: number, newContent: string): string {
  const lines = body.split('\n');

  let lastContent = splitLineIndex - 1;
  while (lastContent >= 0 && lines[lastContent].trim() === '') {
    lastContent--;
  }

  let firstAfter = splitLineIndex;
  while (firstAfter < lines.length && lines[firstAfter].trim() === '') {
    firstAfter++;
  }

  const newLines = newContent.split('\n');
  let nlStart = 0;
  let nlEnd = newLines.length - 1;
  while (nlStart <= nlEnd && newLines[nlStart].trim() === '') nlStart++;
  while (nlEnd >= nlStart && newLines[nlEnd].trim() === '') nlEnd--;
  const trimmedNew = newLines.slice(nlStart, nlEnd + 1);

  if (trimmedNew.length === 0) {
    // Shouldn't happen — caller validates non-empty content. Defensive return.
    return body;
  }

  const beforePart = lastContent >= 0 ? lines.slice(0, lastContent + 1) : [];
  const afterPart = firstAfter < lines.length ? lines.slice(firstAfter) : [];

  const result: string[] = [];
  if (beforePart.length > 0) {
    result.push(...beforePart);
    result.push('');
  }
  result.push(...trimmedNew);
  if (afterPart.length > 0) {
    result.push('');
    result.push(...afterPart);
  } else {
    result.push('');
  }

  return result.join('\n');
}

/**
 * High-level entry point: take the raw file content, the heading spec, and
 * the new content; return the rewritten file. Frontmatter is preserved
 * byte-identical — headings inside frontmatter delimiters never match.
 */
export function appendSectionInDocument(
  fileContent: string,
  spec: HeadingSpec,
  newContent: string,
  opts: LocateOptions = {},
): SpliceResult {
  const { body } = parseFrontmatter(fileContent);
  const frontmatterPrefix = fileContent.slice(0, fileContent.length - body.length);
  const located = locateSection(body, spec, opts);
  const newBody = spliceAppend(body, located.splitLineIndex, newContent);
  return { content: frontmatterPrefix + newBody };
}
