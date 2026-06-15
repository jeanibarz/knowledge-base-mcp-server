# 0006 — Retrieval-time injection guard: detect, tag, and delimit

- **Status:** Accepted (#221)
- **Date:** 2026-05-12
- **Deciders:** Repo owner

## Context and Problem Statement

Knowledge-base files can include text copied from web pages, PDFs, shared notes, or security research corpora. Once retrieved, those bytes are handed to an MCP client and often forwarded into an LLM prompt. Malicious or hostile text in the retrieved chunk can therefore attempt indirect prompt injection against the downstream agent.

The server already treats `$KNOWLEDGE_BASES_ROOT_DIR` as a content trust boundary in the threat model. Before this ADR, that section said the server did no prompt-injection detection and deferred filtering to RFC 006. RFC 006 covers retrieval quality and similarity filtering, not prompt-injection boundaries, so the named mitigation did not actually exist.

## Decision

Add a small retrieval-time content guard at the formatter boundary:

- Default `KB_INJECTION_GUARD=tag`: scan each returned chunk and add additive `metadata.injection_signals`.
- `KB_INJECTION_GUARD=wrap`: wrap returned chunk content in an `<untrusted-doc src="...">` envelope without adding signal metadata.
- `KB_INJECTION_GUARD=both`: scan and wrap.
- `KB_INJECTION_GUARD=off`: preserve the historical content and metadata shape.
- `KB_INJECTION_GUARD_BYPASS_KBS`: comma-separated KB names that skip both detection and wrapping.

The v0 detector is deterministic and local. It checks for system-role markers, common instruction-override phrases, Unicode bidi controls, zero-width controls, and Unicode tag characters. It never blocks, strips, rewrites, or calls an LLM classifier.

## Decision Drivers

- **Additive default.** Tagging exposes risk signals to clients without suppressing legitimate retrieved content.
- **Explicit delimiter.** Wrapping is opt-in because it changes content bytes, but it gives downstream LLMs a clear untrusted-content boundary when operators want that contract.
- **Bypass for security corpora.** KBs that intentionally store injection examples can opt out by name to avoid noisy metadata and wrapped fixtures.
- **No provider dependency.** Regex and Unicode-class checks avoid latency, cost, and model-provider trust expansion.
- **Narrow implementation.** The formatter is the shared retrieval render path for MCP and CLI JSON/markdown/grouped outputs, so the guard does not need MCP schema or CLI command changes.

## Considered and Rejected

- **Content stripping.** Removing detected text can corrupt retrieval results and make security research KBs unusable. Rejected for v0.
- **LLM classifier.** Classifiers add provider calls, cost, latency, and another prompt-injection surface. Rejected for v0.
- **Fail-closed blocking.** Pattern matching is incomplete and false positives are expected. Blocking would create an unreliable availability and correctness hazard. Rejected.
- **Config-module validation.** The initial implementation keeps env parsing local to `src/injection-guard.ts` to avoid widening shared configuration surfaces. Malformed modes fall back to the default tag behavior.

## Consequences

Positive:

- Retrieved chunks now carry visible injection indicators by default.
- Operators can opt into explicit untrusted-content delimiters.
- Historical output remains available with `KB_INJECTION_GUARD=off`.

Tradeoffs:

- Detection is heuristic and incomplete.
- Default metadata shape changes by adding `injection_signals: []` even when no signals are found.
- Wrap mode changes chunk content and can affect byte-sensitive evaluations.

## Validation

- `src/injection-guard.test.ts` covers signal detection, envelope rendering, malformed mode fallback, and bypass behavior.
- `src/formatter.test.ts` covers default metadata tagging, off-mode compatibility, wrap-mode content, and bypass behavior through the retrieval formatter.

## More Information

- Threat model §2: `$KNOWLEDGE_BASES_ROOT_DIR` content / prompt-injection boundary.
- Issue #221: retrieval-time indirect prompt-injection content guard.
