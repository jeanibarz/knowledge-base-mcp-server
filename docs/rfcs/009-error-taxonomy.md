# RFC 009 — Structured MCP error taxonomy

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 008 (remote transport — introduces a separate HTTP-layer error surface that must not double-wrap MCP-tool errors), RFC 010 (MCP surface v2 — new tools inherit this taxonomy for their path-guard and KB-name validator throws)
- **References (GitHub issues):** #58 (remains open; implementation PRs per §10 close it)

## 1. Summary

Every error returned from the two MCP tools today is a freeform English string:
`src/KnowledgeBaseServer.ts:68` emits `"Error listing knowledge bases: ${error.message}"`;
`src/KnowledgeBaseServer.ts:119` emits `"Error retrieving knowledge: ${error.message}"`. Both
go over the wire as `CallToolResult.content[0].text` with `isError: true` — correct MCP
shape, but the payload is prose. Programmatic clients that want to distinguish
"provider auth failed — ask the user for a new key" from "index not initialized — retry after
init" from "permission denied — surface to the admin" either substring-match the English
text or give up and show the raw prose to end users.

This RFC defines (a) a flat, extensible set of stable `code` identifiers covering every
current throw site and a handful of codes the downstream RFCs (008, 010) will need, (b) a
`KBError` class that carries `{ code, message, cause?, hint?, transient }`, (c) the MCP
wire contract — keep `isError: true` + `content: [{ type: 'text', text: ... }]` (required by
the MCP spec) but switch the text to a JSON document `{"error":{"code":"...","message":"...","transient":false,"hint":"..."}}`,
(d) a classification rule — wrap at throw sites, serialize at the MCP boundary, never
re-classify in between, and (e) a rollout plan across five milestones so each PR stays
small and reviewable.

The RFC **does not** implement anything. Every milestone in §10 lands as its own PR.

## 2. Motivation

### 2.1 Evidence from code

- **Freeform error text is all the client gets.** `handleListKnowledgeBases` catches any
  thrown error and returns the English string at `src/KnowledgeBaseServer.ts:68`:
  ```ts
  const content: TextContent = {
    type: 'text',
    text: `Error listing knowledge bases: ${error.message}`,
  };
  return { content: [content], isError: true };
  ```
  `handleRetrieveKnowledge` does the same at `src/KnowledgeBaseServer.ts:119`. The catch
  block cannot tell whether the rejection came from the filesystem, the embedding
  provider, a path-traversal guard, or a bug; it just prepends the English prefix and
  returns. A client reading `"Error retrieving knowledge: OPENAI_API_KEY environment
  variable is required when using OpenAI provider"` has to substring-match `"API_KEY"` to
  know it is an auth problem — brittle, locale-blind, and subject to phrasing drift.

- **Throw sites already carry the information the catch site discards.** The provider
  constructor at `src/FaissIndexManager.ts:100` knows the failure is a missing OpenAI
  API key:
  ```ts
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required when using OpenAI provider');
  }
  ```
  The HuggingFace equivalent at `src/FaissIndexManager.ts:112` is the same shape. The
  `similaritySearch` guard at `src/FaissIndexManager.ts:404` knows the failure is
  "index not initialized":
  ```ts
  if (!this.faissIndex) {
    throw new Error('FAISS index is not initialized');
  }
  ```
  In every case the knowledge is thrown away by the time the MCP boundary serializes.

- **Filesystem errors already have structured codes — the server drops them.**
  `isPermissionError` at `src/FaissIndexManager.ts:42-48` inspects the `FsError.code`
  field to distinguish `EACCES | EPERM | EROFS`, and `handleFsOperationError` at
  `src/FaissIndexManager.ts:50-78` takes a dedicated permission-denied branch at
  `src/FaissIndexManager.ts:53-63`. The structured information lives inside the function;
  the re-thrown `Error` carries only a prose message ("Permission denied while attempting
  to …"). The taxonomy work is partly a matter of plumbing what is already classified.

- **Corrupt-index recovery is classified in logs but not on the wire.** The recovery path
  at `src/FaissIndexManager.ts:171-188` logs `"Existing FAISS index … is corrupt or
  unreadable - rebuilding from source"` at `warn` level. The recovery usually succeeds
  silently — but when the subsequent rebuild also fails (e.g. the unlink at
  `src/FaissIndexManager.ts:181` hits `EACCES`), the `handleFsOperationError` rethrow at
  `src/FaissIndexManager.ts:181-182` bubbles up untagged. A client that wants to
  distinguish "your index is corrupt, probably not your fault" from "permission denied"
  cannot.

### 2.2 What clients need

A programmatic MCP client wants to branch on the failure mode, not the phrasing.
Concrete behaviours the current string-only payload blocks:

- **Transient vs permanent.** "Provider timeout" is a retry candidate; "provider 401"
  is not. The client's retry logic needs a boolean hint it can trust.
- **Who to surface to.** `PERMISSION_DENIED` on the index directory is an operator
  problem — route to the admin channel. `PROVIDER_AUTH` is a user-key problem — prompt
  the user for a new key. `KB_NOT_FOUND` is a user-typo problem — show a picker.
- **What to display.** End-user UIs should not display `"Error retrieving knowledge:
  ENOENT: no such file or directory, open '/srv/kb-server/kb/onboarding/secret.md'"` —
  the absolute path leaks deployment topology. With a stable code the UI can render
  locale-appropriate text and omit server-side details.
- **Documentation anchors.** `README.md` today has no "MCP error codes" section; there is
  nothing for a client author to program against. RFC 010 will add six more tools and
  the same absence will be six times worse without a taxonomy.

### 2.3 Coordination pressure

Two in-flight RFCs amplify the cost of not fixing this now:

- **RFC 008 (remote transport).** The HTTP listener has its own error surface — `401
  Unauthorized`, `403 Forbidden`, `404 Not Found`, etc. — *separate* from MCP-tool errors.
  Without a clear boundary, an MCP-tool failure served over HTTP could be wrapped twice
  (HTTP 500 + MCP `isError`) or, worse, leaked as an HTTP status when the transport
  shouldn't care about tool semantics. §7 specifies the separation.
- **RFC 010 (MCP surface v2).** Adds six tools (§5.3–§5.6 of RFC 010) that all consume a
  `resolveKbPath` guard and an `isValidKbName` validator (RFC 010 §5.1.1, §5.1.2). Each
  of those throws. Without a taxonomy now, RFC 010 either invents one inline (drift
  risk) or ships the same freeform strings (defeats its own user story). The taxonomy
  must land first; RFC 010 then maps its throws into the codes defined here.

## 3. Goals

- **G1. Stable `code` identifiers** that clients can branch on without substring-matching
  English text. Codes are the versioned contract; messages are not.
- **G2. Every current throw in `src/` flows through the taxonomy** by the end of §10 M3,
  so that no catch site at the MCP boundary defaults to `INTERNAL` for a known failure
  mode.
- **G3. JSON-serialisable wire payload** inside the existing MCP `CallToolResult` shape,
  so clients (including future HTTP-transport clients from RFC 008) can parse the error
  without re-inferring structure from prose.
- **G4. No absolute paths, API keys, or stack traces in the `message` field.** Server-side
  logs retain every diagnostic; the wire payload is user-safe.
- **G5. Extensible without breaking.** Adding a new code is additive (not a new major);
  clients that don't recognise a code must degrade gracefully via `transient` + `message`
  + the documented "unknown code ⇒ treat as `INTERNAL`" rule.

## 4. Non-goals

- **i18n of error messages.** The `message` field is English and is allowed to drift across
  versions; the `code` is the stable contract. A client that needs localised prose maps
  codes → locale strings itself.
- **Semantic-version commitment to the message text.** Only `code` and `transient` are
  SemVer-stable. Message wording, `hint` content, and the presence of `cause` may change
  between minor releases.
- **Error-to-HTTP-status mapping beyond what RFC 008 specifies.** This RFC does not
  prescribe that `PROVIDER_AUTH` becomes HTTP 502 or anything similar. The HTTP listener
  in RFC 008 has its own error surface (§6.3 of RFC 008) for transport-layer failures;
  MCP-tool errors travel inside the JSON-RPC body with HTTP 200 regardless. §7 draws the
  line.
- **Retry policy.** `transient: true` is a *hint* — the client decides whether to retry,
  with what backoff, and how many times. The server does not retry on behalf of callers
  and does not expose a retry-after header.
- **Sub-codes (`PROVIDER.AUTH.MISSING_KEY` etc.).** Flat namespace only in v1; §8.3
  discusses why.
- **Client SDKs.** No TypeScript `KBErrorCode` type exported for clients to depend on.
  Clients read the JSON. An exported type is a drive-by if a downstream SDK wants it.
- **`KBError` class as a wire contract.** The **wire JSON shape in §5.4 is the
  contract**; the `KBError` class is a server-internal convenience for composing and
  classifying errors. Clients MUST NOT assume access to a compatible TypeScript class,
  nor that the class fields map 1:1 to wire fields (the class carries `cause` and a
  `stack` inherited from `Error`; neither appears on the wire). Internal changes to the
  class are not SemVer-relevant.

## 5. Proposed design

### 5.1 The `KBError` class

**Location:** new file `src/errors.ts`.

```ts
export type KBErrorCode =
  | 'INDEX_NOT_INITIALIZED'
  | 'CORRUPT_INDEX'
  | 'KB_NOT_FOUND'
  | 'PATH_INVALID'
  | 'PATH_ESCAPES_ROOT'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMIT'
  | 'PERMISSION_DENIED'
  | 'DISK_FULL'
  | 'VALIDATION'
  | 'INTERNAL';

export interface KBErrorOptions {
  cause?: unknown;
  hint?: string;
  transient?: boolean;
}

export class KBError extends Error {
  readonly name = 'KBError';
  readonly code: KBErrorCode;
  readonly hint?: string;
  readonly transient: boolean;
  readonly cause?: unknown;

  constructor(code: KBErrorCode, message: string, options: KBErrorOptions = {}) {
    super(message);
    this.code = code;
    this.hint = options.hint;
    this.transient = options.transient ?? DEFAULT_TRANSIENT[code];
    this.cause = options.cause;
  }
}
```

- **`name` is a class-level constant `'KBError'`** so downstream catch sites can
  `err instanceof KBError || err?.name === 'KBError'` without an explicit import (useful
  across RFC 010's module boundaries).
- **`transient` has a per-code default** (see §5.2 table) so a throw site that omits the
  option inherits the taxonomy's classification rather than falling back to "false".
- **`cause`** preserves the original thrown value for server-side logging. It is
  **never** serialised to the wire — §5.4 strips it in the serializer.
- **`hint`** is an optional short actionable string the server can suggest to the client.
  Freeform English; not versioned; may be absent.

### 5.2 The taxonomy

Each code lists: (a) when it fires, with `file.ts:line` anchors on current `main`;
(b) its transience default; (c) the message contract ("must include" / "must NOT
include"); (d) the typical `hint`.

| Code                     | Transient (default) | When it fires |
| ------------------------ | :----------------: | ------------- |
| `INDEX_NOT_INITIALIZED`  | **true**           | `FaissIndexManager.similaritySearch` at `src/FaissIndexManager.ts:403-405`: `retrieve_knowledge` is called before any document has been embedded. Usually self-heals after `updateIndex()` completes. |
| `CORRUPT_INDEX`          | **false**          | `FaissStore.load` throws at `src/FaissIndexManager.ts:169` and the rebuild path (`src/FaissIndexManager.ts:171-188`) cannot recover (e.g. the `unlink` at `:181` also fails, or the subsequent rebuild throws). Classification fires at the outermost catch in `initialize()` (`src/FaissIndexManager.ts:200-208`) when `error.__alreadyLogged` indicates a pre-classified rebuild failure. |
| `KB_NOT_FOUND`           | false              | `handleRetrieveKnowledge` with a `knowledge_base_name` that does not exist under `KNOWLEDGE_BASES_ROOT_DIR`. Today the failure surfaces as an `ENOENT` from `fsp.readdir`/`getFilesRecursively`; M2 classifies at the point of KB resolution. RFC 010's new tools throw this from `resolveKbPath` when the KB directory is missing. |
| `PATH_INVALID`           | false              | RFC 010 `resolveKbPath` rejections for structural reasons detected *before* the prefix check: null byte (RFC 010 §5.1.1 step 2), absolute path (step 4's `isAbsolute` rejection), and lexical `..` segments (step 4's segment-aware rejection — a lexically-obvious traversal attempt is classified as `PATH_INVALID`, not `PATH_ESCAPES_ROOT`, because the prefix check never runs on these inputs). Step 3 is pure normalization and does not throw. Not currently thrown in this repo — reserved for RFC 010. |
| `PATH_ESCAPES_ROOT`      | false              | RFC 010 `resolveKbPath` rejection at step 7 only — the post-realpath prefix check that catches symlinks pointing outside the KB root. Lexical traversal is classified as `PATH_INVALID` (row above); only traversal that survives normalization and is exposed by realpath surfaces this code. Reserved for RFC 010. |
| `PROVIDER_AUTH`          | false              | Missing / rejected API keys. Fires at `src/FaissIndexManager.ts:100` (OpenAI missing key) and `src/FaissIndexManager.ts:112` (HuggingFace missing key). Extended in M2 to cover runtime 401/403 responses from the provider (detectable via `error.status` or `error.response.status` on the `@langchain/*` embedding call). |
| `PROVIDER_TIMEOUT`       | **true**           | Embedding-provider HTTP call exceeds the provider client's timeout. Detected by `error.code === 'ETIMEDOUT'` or `error.name === 'AbortError'` during `embedDocuments` / `embedQuery`. M2 classifies at the catch surrounding `FaissStore.fromTexts` / `addDocuments` / `similaritySearchWithScore`. |
| `PROVIDER_UNAVAILABLE`   | **true**           | Network-level failures to reach the provider: `ECONNREFUSED` (Ollama daemon not running), `ENOTFOUND` (DNS), `ECONNRESET`, or provider-side 5xx. Classification lives next to `PROVIDER_TIMEOUT`. |
| `PROVIDER_RATE_LIMIT`    | **true**           | Provider returns HTTP 429. Kept separate from `PROVIDER_UNAVAILABLE` so clients can apply longer backoff. |
| `PERMISSION_DENIED`      | false              | `handleFsOperationError` at `src/FaissIndexManager.ts:50-78` takes the permission branch when `isPermissionError(error)` (`src/FaissIndexManager.ts:42-48`) is true — `EACCES` / `EPERM` / `EROFS`. M2 replaces the ad-hoc `Error` constructed at `src/FaissIndexManager.ts:59-63` with a `KBError('PERMISSION_DENIED', …)` and keeps the existing `__alreadyLogged` flag behaviour. |
| `DISK_FULL`              | false              | `ENOSPC` during any filesystem write path — `fsp.writeFile` for hash sidecars (`src/FaissIndexManager.ts:374`), `fsp.rename` (`src/FaissIndexManager.ts:375`), `FaissStore.save` (`src/FaissIndexManager.ts:359`), `fsp.writeFile(MODEL_NAME_FILE, …)` (`src/FaissIndexManager.ts:196`). Detected by `error.code === 'ENOSPC'` in `handleFsOperationError`. Kept distinct from `PERMISSION_DENIED` because the operator response is different (free disk, not grant access). |
| `VALIDATION`             | false              | Input validation failures not covered by the more specific path / KB codes. RFC 010's `isValidKbName` rejection (RFC 010 §5.1.2) throws `VALIDATION` rather than `KB_NOT_FOUND` because a bad name never resolves to a missing directory — §8.2 records this decision. Reserved for RFC 010 in v1. |
| `INTERNAL`               | false              | Default for any error the catch site cannot classify. Includes bugs, unexpected provider-SDK exceptions, and any `Error` reaching the MCP boundary without a `KBError` wrapper. **The goal is that this bucket shrinks to zero on the happy path.** |

**Transience recap.** `INDEX_NOT_INITIALIZED`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
and `PROVIDER_RATE_LIMIT` default `transient: true`. Every other code defaults
`transient: false`. A throw site may override the default via `KBError`'s options — for
example, a `PROVIDER_AUTH` thrown from "HuggingFace key was valid but is now revoked"
*could* pass `transient: false` explicitly, but a `PROVIDER_UNAVAILABLE` whose underlying
cause is a DNS misconfiguration (permanent until operator fix) can still default to
`transient: true` because the client's backoff will eventually surface it.

### 5.3 Naming convention for future codes

The taxonomy is designed to extend without breaking. New codes must:

- **Be SCREAMING_SNAKE_CASE**, ASCII, `[A-Z][A-Z0-9_]*`.
- **Use an existing prefix when one fits.** `PROVIDER_*` is the embedding-provider-error
  family; `PATH_*` is the path-resolution family. Invent a new prefix only when the
  family doesn't exist (e.g. RFC 010's ingest may eventually want a `DOCUMENT_*` family
  for `DOCUMENT_TOO_LARGE`, `DOCUMENT_UNSUPPORTED_FORMAT`).
- **Be semantically orthogonal to existing codes.** `PROVIDER_AUTH` + `PROVIDER_TIMEOUT`
  are orthogonal; a new `PROVIDER_AUTH_TIMEOUT` is a sub-code and belongs in `hint`, not
  as a new top-level code.
- **Ship with the same fields as the table in §5.2** in the RFC or issue that introduces
  them: when it fires (`file:line` anchor), transience default, message contract, hint.
- **Be declared in `src/errors.ts`'s `KBErrorCode` union** and nowhere else. Clients
  read the JSON; the TypeScript union is the server's internal contract.

**Backward compatibility.** Removing or renaming a code is a breaking change and bumps
the minor per the repo's current pre-1.0 policy (post-1.0: major). Adding a code is not
— the documented "unknown code ⇒ treat as `INTERNAL`" rule (§5.5, §6) keeps clients
correct.

**Exhaustiveness enforcement.** `DEFAULT_TRANSIENT` (§5.1) is typed as
`Record<KBErrorCode, boolean>`, so TypeScript refuses to compile if a new code is added
to the union without a transience default in the same commit. This is deliberate: a
new code without a transience classification would be a latent retry-policy bug.
"Additive" here means "does not break clients"; authoring changes still require the
new code to register with the map.

### 5.4 Wire contract

MCP requires tool errors to flow through the `CallToolResult` shape: `content: [{ type:
'text', text: string }]` with `isError: true`. The SDK type is imported at
`src/KnowledgeBaseServer.ts:5`. RFC 009 **keeps that shape** and changes only the `text`
field content from prose to a JSON document with a stable schema.

**Serialized payload (JSON, single-line, UTF-8, no trailing newline):**

```jsonc
{
  "error": {
    "code": "PROVIDER_AUTH",
    "message": "OPENAI_API_KEY is not set.",
    "transient": false,
    "hint": "Set the OPENAI_API_KEY environment variable and restart the server."
  }
}
```

**Schema rules.**

- `error` is a top-level object. The bare top-level shape — instead of returning the
  error fields directly — leaves room for future siblings (e.g. `warnings`) without a
  breaking change.
- `error.code: KBErrorCode` — required, one of the codes in §5.2.
- `error.message: string` — required, non-empty, English, ≤ 256 bytes. Safe to display.
- `error.transient: boolean` — required. Reflects `KBError.transient`.
- `error.hint?: string` — optional, ≤ 256 bytes when present. Absent if the throw site
  did not set one.
- `error.cause` — **never emitted.** The serializer strips it unconditionally (§5.5 R4).
- `error.stack` — **never emitted.** The serializer strips it unconditionally.
- No other top-level keys. Clients MUST ignore unknown keys under `error` for forward
  compatibility.

**The outer `CallToolResult` is unchanged:**

```ts
return {
  content: [{
    type: 'text',
    text: JSON.stringify({ error: { code, message, transient, hint } }),
  }],
  isError: true,
};
```

**Why JSON inside a `TextContent` rather than a different content type.** MCP's
`CallToolResult` only allows `TextContent | ImageContent | EmbeddedResource | …`; there
is no `ErrorContent` type. The SDK treats `isError: true` as the signal and leaves the
payload shape to the server. Emitting JSON in `TextContent` is the established pattern
other MCP servers use (e.g. `chroma-mcp`) and is a shape the SDK does not parse.

**Compatibility break (documented).** Older clients that read the `text` field as prose
today will see JSON instead of English after M3 ships. A client that displayed the prose
directly to the user will now display a JSON blob. §8.1 R1 lists the migration guidance;
M4 adds a README "MCP error codes" section and a CHANGELOG migration note.

### 5.5 Classification strategy: wrap at throw sites, serialize at the boundary

**Rule 1 — Classify at the throw site.** Throw sites have the most context about *why*
the operation failed. They wrap into a `KBError` with the correct code inline:

```ts
// src/FaissIndexManager.ts:99-101 (today)
if (!openaiApiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required when using OpenAI provider');
}

// After M2:
if (!openaiApiKey) {
  throw new KBError('PROVIDER_AUTH', 'OPENAI_API_KEY is not set.', {
    hint: 'Set OPENAI_API_KEY and restart.',
    transient: false,
  });
}
```

**Rule 2 — Do not re-classify in middle layers.** If a function catches a `KBError` and
needs to add context, it may re-throw a **new** `KBError` with a more specific code and
the original set as `cause`. It must not mutate the caught error. A function that catches
something it doesn't understand must re-throw unchanged — not wrap as `INTERNAL` in the
middle of the stack. `INTERNAL` wrapping happens exactly once, at the MCP boundary.

**Rule 3 — The MCP boundary serializes.** The catch blocks at
`src/KnowledgeBaseServer.ts:61-71` and `src/KnowledgeBaseServer.ts:114-121` call a shared
helper `serializeErrorForMcp(error)`:

```ts
// src/errors.ts (added in M3)
export function serializeErrorForMcp(error: unknown): CallToolResult {
  const kbError = error instanceof KBError
    ? error
    : new KBError('INTERNAL', 'An unexpected error occurred.', { cause: error });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: {
          code: kbError.code,
          message: kbError.message,
          transient: kbError.transient,
          ...(kbError.hint ? { hint: kbError.hint } : {}),
        },
      }),
    }],
    isError: true,
  };
}
```

**Rule 4 — The serializer strips `cause` and `stack` unconditionally.** Even if a throw
site accidentally places a raw provider response (with an API key in a header) in
`cause`, it never reaches the wire. Server-side logging retains `cause` and `stack` and
writes them to stderr per `logger.ts`'s invariant.

**Rule 5 — Unknown-error default is `INTERNAL` with a generic message.** The fallback
message in rule 3's snippet is **not** the caught error's `message`. A generic
"An unexpected error occurred." is used instead so that a leaked `ENOENT: no such file or
directory, open '/srv/kb-server/kb/foo/bar.md'` — which a raw Node error carries — does
not surface an absolute path on the wire. Server logs carry the full prose; the wire
gets the generic string.

**Rule 6 — The classification helpers move into `src/errors.ts`.** `isPermissionError`
(today at `src/FaissIndexManager.ts:42-48`) is repurposed, not replaced. M1 moves it to
`src/errors.ts` alongside a new `classifyFsError(error)` that maps `EACCES/EPERM/EROFS →
PERMISSION_DENIED`, `ENOSPC → DISK_FULL`, `ENOENT → KB_NOT_FOUND` (only when the caller
is resolving a KB-level path; otherwise let it bubble to `INTERNAL`). `FaissIndexManager`
imports them; the `__alreadyLogged` flag handling is preserved verbatim.

### 5.6 Message contract — what to include, what to leak-check

The `message` field must be safe to display to an end user. The contract:

- **MUST include** enough context for a human to recognise the failure mode — the
  triggering operation and the specific condition that failed. `"OPENAI_API_KEY is not
  set."` is good; `"auth failed"` is not.
- **MUST NOT include** absolute filesystem paths. `PERMISSION_DENIED`'s server-side log
  at `src/FaissIndexManager.ts:54-55` (`"Permission denied while attempting to ${action}
  ${pathDescription}"` where `pathDescription = path.resolve(targetPath)`) is fine for
  stderr but the wire `message` must describe the operation in relative or categorical
  terms — e.g. `"Permission denied writing to the FAISS index directory."`. M2
  introduces a `toPublicPath(absPath)` helper that reduces an absolute path to either
  `<relative to KB root>` for KB-scoped paths or `<FAISS index dir>` / `<config dir>` /
  redacted for infra paths. **Invariant:** every throw site that composes a public
  `message` from a filesystem path MUST route the path through `toPublicPath` first.
  Raw `targetPath` / `path.resolve(targetPath)` / `MODEL_NAME_FILE` (which is inside
  `FAISS_INDEX_PATH` at `src/FaissIndexManager.ts:25`) values must never be
  interpolated directly into the public message. The leak tests in §11.2 N1 verify
  this invariant by sentinel-seeding both `KNOWLEDGE_BASES_ROOT_DIR` and
  `FAISS_INDEX_PATH`.
- **MUST NOT include** API keys, tokens, bearer credentials, or any value read from
  `process.env.*_API_KEY`. **Never copy `cause.message` or any provider-SDK
  `error.message` into the public `message`.** Provider SDKs routinely echo the
  offending request (including `Authorization: Bearer sk-…` headers) in their thrown
  `Error.message`; a throw site that builds a public message by interpolating the
  upstream `cause.message` re-exposes the secret even though the *caller* never read
  it from `process.env`. The provider-error adaptor in M2 (`classifyProviderError`)
  computes the public message from the classified **code alone** (plus a short
  operator-supplied phrase — e.g. `"The embedding provider rejected the request
  (401)."` for `PROVIDER_AUTH`) and discards the raw upstream text. Upstream text
  stays in `cause` for stderr logging.

- **All MUST-NOT rules in this section apply equally to `hint`.** `hint` is a wire
  field (§5.4) and reaches the same clients as `message`. A throw site like
  `KBError('PERMISSION_DENIED', …, { hint: \`Check that ${absPath} exists.\` })` would
  leak an absolute path through `hint` with no path-interpolation happening in
  `message`. `hint` text MUST route through `toPublicPath` on the same terms and MUST
  NOT include `cause.message`, API keys, or stack traces. The leak tests in §11.2
  scan both fields explicitly.
- **MUST NOT include** stack traces or `cause.message` concatenated into the public
  message. Server-side logs have both; the wire does not.
- **SHOULD be ≤ 256 bytes.** Longer messages truncate (hard cap at 1024, middle-ellipsis)
  rather than reject — a truncated message is better than dropping the error. The
  truncation is a last-line defence; authoring PRs should stay under 256 naturally.

### 5.7 Classification throw-site map (what M2 has to change)

| Throw site (`file:line` on current `main`)                                               | Today                                                                              | After M2                                                         |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/FaissIndexManager.ts:100`                                                          | `Error('OPENAI_API_KEY environment variable is required …')`                      | `KBError('PROVIDER_AUTH', …)`                                    |
| `src/FaissIndexManager.ts:112`                                                          | `Error('HUGGINGFACE_API_KEY environment variable is required …')`                 | `KBError('PROVIDER_AUTH', …)`                                    |
| `src/FaissIndexManager.ts:59-63` (permission branch of `handleFsOperationError`)        | plain `Error`, `__alreadyLogged = true`                                            | `KBError('PERMISSION_DENIED', …, { cause, hint })`               |
| `src/FaissIndexManager.ts:65-77` (generic branch of `handleFsOperationError`)           | rethrow existing `Error` or new `Error(...)`                                       | classify via `classifyFsError`; fallback `KBError('INTERNAL')`  |
| `src/FaissIndexManager.ts:404`                                                          | `Error('FAISS index is not initialized')`                                          | `KBError('INDEX_NOT_INITIALIZED', …, { transient: true })`       |
| `src/FaissIndexManager.ts:171-188` (corrupt + rebuild path)                             | warn-and-recover; rethrow unclassified on rebuild failure                          | on rebuild failure, wrap as `KBError('CORRUPT_INDEX', …)`        |
| Embedding-provider calls (implicit — `FaissStore.fromTexts` / `addDocuments` / `similaritySearchWithScore`) | provider SDK errors bubble through `handleRetrieveKnowledge`'s catch unclassified | M2 adds a `classifyProviderError(error)` in the catch at `src/FaissIndexManager.ts:388-396` |
| RFC 010 `resolveKbPath` throws (RFC 010 §5.1.1 steps 2/3/4/7)                           | n/a                                                                                 | `KBError('PATH_INVALID' | 'PATH_ESCAPES_ROOT', …)` at the RFC-010 throw sites |
| RFC 010 `isValidKbName` rejection (RFC 010 §5.1.2)                                     | n/a                                                                                 | `KBError('VALIDATION', …)`                                       |
| RFC 010 `resolveKbPath` when KB directory is missing                                    | n/a                                                                                 | `KBError('KB_NOT_FOUND', …)`                                    |

## 6. Example payloads

**Success** (`list_knowledge_bases` today — unchanged):

```json
["onboarding", "company"]
```

**`PROVIDER_AUTH`** (missing OpenAI key):

```json
{
  "error": {
    "code": "PROVIDER_AUTH",
    "message": "OPENAI_API_KEY is not set.",
    "transient": false,
    "hint": "Set OPENAI_API_KEY in the server environment and restart."
  }
}
```

**`INDEX_NOT_INITIALIZED`** (first `retrieve_knowledge` before any docs have been
embedded):

```json
{
  "error": {
    "code": "INDEX_NOT_INITIALIZED",
    "message": "The FAISS index has not been built yet.",
    "transient": true,
    "hint": "The server will build the index on first retrieval; retry shortly."
  }
}
```

**`PERMISSION_DENIED`** (operator hasn't granted write access to the index directory):

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Permission denied writing to the FAISS index directory.",
    "transient": false
  }
}
```

Note: no absolute path; operator sees the full path in stderr.

**`INTERNAL`** (unclassified fallback):

```json
{
  "error": {
    "code": "INTERNAL",
    "message": "An unexpected error occurred.",
    "transient": false
  }
}
```

Note: no provider stack trace, no `cause.message`. The operator sees the detail in
stderr; the client sees the generic string.

## 7. Coordination with RFC 008 (HTTP transport)

RFC 008 introduces an HTTP listener with its own error surface: `401 Unauthorized` with
the full `WWW-Authenticate: Bearer realm="knowledge-base-mcp"` challenge (RFC 008 §6.3),
`403 Forbidden` for origin mismatch (RFC 008 §6.4), `404 Not Found` for unmatched
routes, `500 Internal Server Error` for unhandled exceptions in the HTTP dispatch layer.
These are **transport-layer** failures and they do not pass through the MCP-tool error
path.

**The rule.** HTTP-layer errors are emitted by the RFC 008 wrapper *before* any MCP
dispatch. An MCP-tool error (i.e. one that originates inside `handleListKnowledgeBases`
or `handleRetrieveKnowledge` or an RFC 010 handler) is a **successful HTTP request**:
the transport returns HTTP 200 with a JSON-RPC body whose `result` field carries
`{ content: […], isError: true }`. The JSON inside `content[0].text` is the RFC 009
payload.

**No double-wrap.** The HTTP wrapper must not map `KBError.code` to an HTTP status. A
`PROVIDER_AUTH` inside the server does **not** become `401` on the HTTP layer — `401`
is reserved for *HTTP bearer-token* failures against the RFC 008 listener itself.
Conflating the two would leak the server's internal auth state to any client that can
reach the listener.

**No cross-pollination of shapes.** The HTTP wrapper's `401` body is deliberately empty
(RFC 008 §6.3, "details help the attacker more than the operator"). It does NOT emit an
RFC 009 payload; a client parsing the HTTP response at the transport layer sees the
empty body and the `WWW-Authenticate: Bearer` header. Only when the client has
authenticated and its JSON-RPC `tools/call` request reaches the MCP dispatcher does the
RFC 009 error shape become relevant.

The separation is reflected in the implementation: `serializeErrorForMcp` lives in
`src/errors.ts`; HTTP status selection lives in RFC 008's `HttpTransportHost`; neither
imports the other.

**Error-oracle safety.** Distinct codes (`INDEX_NOT_INITIALIZED` vs `KB_NOT_FOUND` vs
`PERMISSION_DENIED`) would be an information-disclosure vector if an unauthenticated
caller could probe them. They are not: on stdio the client owns the server process and
trust is already conferred; on HTTP the RFC 008 bearer-auth layer (§6.3 of RFC 008)
rejects unauthenticated requests *before* dispatch reaches any MCP handler, so every
MCP-tool error is post-auth by construction. Anonymous probes hit the empty-body `401`
and learn nothing about index state.

## 8. Alternatives considered

### 8.1 Error-as-a-string (status quo)

Keep the current `"Error retrieving knowledge: ${error.message}"` payload; advise clients
to substring-match. **Rejected** — issue #58 is the explicit motivation. Substring
matching is locale-blind, non-versioned, and rots whenever any upstream error message is
re-phrased. The only argument for it is "no work"; that is the status quo, and the
status quo blocks the use cases in §2.2.

### 8.2 HTTP-style numeric codes

Reuse HTTP status semantics inside the MCP payload — `401` for auth, `404` for KB not
found, `503` for provider unavailable, etc. **Rejected.** MCP is a JSON-RPC protocol, not
HTTP; numeric codes have no established meaning in that layer. A `404` inside MCP would
collide semantically with RFC 008's HTTP `404` at the transport layer and create exactly
the double-wrap risk §7 warns against. Semantic names (`KB_NOT_FOUND`) travel better,
document better, and are self-describing in log lines.

### 8.3 Hierarchical sub-codes

`PROVIDER.AUTH.MISSING_KEY` vs `PROVIDER.AUTH.REVOKED_KEY` vs `PROVIDER.TIMEOUT`.
**Considered, deferred.** Call sites at RFC 009 v1 do not need sub-codes — every
identified throw maps cleanly to a single flat code. Introducing a hierarchy now imposes
parsing cost on every client (split on `.`) and invites drift (is it `PROVIDER.AUTH` or
`PROVIDER_AUTH`?). Flat namespace is enough for v1; a future RFC can introduce
hierarchy if call-site growth actually demands it. Hints cover the "sub-reason"
information need today.

### 8.4 Throw `KBError` vs return `Result<T, KBError>`

Rust-style `Result` types would be type-safe and force every caller to handle the error
path. **Rejected.** TypeScript has no ergonomic `Result` idiom; introducing one would
require a library (`neverthrow` etc.) and rewrite every handler. The MCP SDK's handler
signature returns `Promise<CallToolResult>`, and the existing codebase uses `throw` /
`try` / `catch` throughout. Throw-based classification integrates with zero friction.

### 8.5 Classify at catch sites instead of throw sites

Let every throw site stay a plain `Error` and have `KnowledgeBaseServer`'s catch inspect
`error.message` / `error.code` to classify. **Rejected.** This is the "substring match
upstream" anti-pattern — it just moves the brittleness from client to server. Catch-site
classification also can't distinguish provider-auth from user-auth from operator-auth
without the context the throw site already has. Throw-site classification is cheaper to
maintain because each throw is a single addition; catch-site classification is a
case-analysis that grows with every new error.

## 9. Risks, unknowns, open questions

### 9.1 Risks

- **R1 — Breaking change for string-matching clients.** Any client that today reads
  `CallToolResult.content[0].text` expecting prose will, after M3 ships, see a JSON
  string instead. The recommended client migration is: attempt `JSON.parse(text)` and,
  if the parsed object has the RFC 009 shape, render it; otherwise fall back to
  displaying the raw string verbatim. Mitigations in M4: a README "MCP error
  codes" section, a CHANGELOG entry under `[Unreleased] Changed` with the exact
  before/after payloads, and a recommendation to grep client code for `"Error listing
  knowledge bases:"` and `"Error retrieving knowledge:"` prefixes (the two English
  strings emitted today). The break lands in one minor version; no grace period (the
  repo is pre-1.0).
- **R2 — `cause` leakage.** The serializer strips `cause` unconditionally (§5.5 R4) but a
  regression could reintroduce it. M3 adds a test `serializeErrorForMcp.test.ts` asserting
  `JSON.parse(text).error` has **exactly** the four allowed keys and no others.
- **R3 — Stack traces through the `message` field.** A throw site that does
  `new KBError('INTERNAL', err.stack)` would leak every absolute path in the stack. M2
  adds a lint in `src/errors.ts` documentation: never pass `err.stack` or
  `err.message` as the public message. A code review checklist item in the RFC 009 M3
  PR enforces it.
- **R4 — `transient` heuristic is imperfect.** `ETIMEDOUT` from `fetch`/`undici` can
  surface as a network error or a provider-side 504 that reads as `ECONNRESET`; these
  classify as `PROVIDER_TIMEOUT` or `PROVIDER_UNAVAILABLE` depending on which code the
  SDK surfaces. Both default `transient: true`, so the client's retry logic is safe
  regardless. The risk is over-reporting "transient" — a permanent DNS misconfiguration
  will classify as `PROVIDER_UNAVAILABLE` and tell the client to retry forever. Documented
  in M2's CHANGELOG entry; a follow-up issue can refine if clients report churn.
- **R5 — Existing tests assert on the prose.** `src/KnowledgeBaseServer.test.ts:108`
  asserts `expect(result.content[0].text).toMatch(/^Error listing knowledge bases:/)`;
  `src/KnowledgeBaseServer.test.ts:196` has the `retrieve_knowledge` counterpart. **M3
  will break both assertions** when it switches the wire payload to JSON. The fix is in
  the same PR: M3 updates the two test matchers to parse the JSON and assert
  `error.code === 'INTERNAL'` (the fallback for the "unknown thrown error" test fixture
  both assertions use). Recorded explicitly so the M3 reviewer is not surprised by the
  test diff.

### 9.2 Open questions

- **O1 — Should `CORRUPT_INDEX` default `transient: true`?** The current recovery path
  at `src/FaissIndexManager.ts:171-188` is self-healing; the classification only fires
  when recovery fails, at which point the condition is permanent until operator action
  (delete the index dir). §5.2 keeps it `false`. Open to re-evaluation after M2 lands
  and we can measure recovery-failure frequency.
- **O2 — Does `PROVIDER_RATE_LIMIT` need a `retry_after` field?** HTTP 429 responses
  often carry `Retry-After`. The current wire schema has no such field; adding one would
  be additive. Deferred — the client's existing backoff is adequate for v1. A follow-up
  issue captures this if user demand arises.
- **O3 — What about errors during `initialize()` before the MCP server finishes
  handshaking?** `run()` at `src/KnowledgeBaseServer.ts:124-136` catches `initialize()`
  failures in its own try/catch and logs but does not re-throw. A `KBError`-wrapped
  initialize failure has no MCP channel to serialize into. M2 keeps this as a plain log
  (the process is not yet ready to answer tool calls); the first `tools/call` after
  startup will re-hit the failure and flow through the regular serializer. Documented
  in M2 for the record.
- **O4 — Localisation.** Explicitly a non-goal (§4), but if a downstream client wants to
  localise error prose they need the `code` to be stable and the `message` to be
  deterministic per-code-per-version. §5.3's back-compat rule covers this.

## 10. Rollout plan

Five milestones, each a separate PR, each ≤ ~400 lines diff. The RFC itself is not
listed as a milestone — this is the RFC PR.

| Milestone | PR title                                                                        | Files touched                                             | Gate                                                                                                              |
| --------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **M1**    | `feat(errors): introduce KBError + classification helpers`                     | NEW `src/errors.ts`; NEW `src/errors.test.ts`             | `KBError` class, `KBErrorCode` union, `classifyFsError`, `isPermissionError` (migrated), `serializeErrorForMcp` skeleton. No callers yet. Pure addition; tests pass. |
| **M2**    | `refactor(errors): classify throw sites in FaissIndexManager`                  | `src/FaissIndexManager.ts`; `src/FaissIndexManager.test.ts` | Every throw site in §5.7's table (within `FaissIndexManager`) is wrapped. `__alreadyLogged` flag preserved. Unit tests assert code + transient for each throw. No wire change yet (boundary still returns prose). |
| **M3**    | `feat(errors): serialize KBError at the MCP boundary`                          | `src/KnowledgeBaseServer.ts`; `src/KnowledgeBaseServer.test.ts` | `handleListKnowledgeBases` and `handleRetrieveKnowledge` catch blocks call `serializeErrorForMcp`. Wire payload becomes JSON. Tests assert the payload schema, strip of `cause`/`stack`, and the `INTERNAL` fallback for non-`KBError`. |
| **M4**    | `docs(errors): README "MCP error codes" section + CHANGELOG migration note`    | `README.md`; `CHANGELOG.md`                               | README documents every code with its transience and example payload. CHANGELOG entry under `[Unreleased] Changed` includes before/after payload + migration guidance for string-matching clients. |
| **M5** (optional) | `feat(errors): typed error surface for HTTP transport`                 | `src/transport/HttpTransportHost.ts` (per RFC 008 §11); `src/errors.ts` | Applies only after RFC 008 lands. Adds an `HttpTransportError` class for the HTTP layer (`401`/`403`/`500`) so RFC 008's transport errors are as typed as the MCP-tool errors. Explicitly separate class — §7 boundary is preserved. Deferred until RFC 008 reaches its M1. |

**Dependencies.**

- M2 depends on M1 (imports `KBError`).
- M3 depends on M2 (without classified throws the serializer has nothing to serialize
  beyond `INTERNAL` fallback).
- M4 depends on M3 (documents the wire shape that M3 ships).
- M5 depends on RFC 008 having reached at least its HTTP-skeleton milestone; it does
  **not** depend on M3, but pragmatically lands after because of review bandwidth.
- RFC 010 milestones that introduce the new tools (M2–M6 in RFC 010 §8) import from
  `src/errors.ts` as soon as M1 here lands. RFC 010's path-guard and KB-name validator
  throws map directly into `PATH_*`, `KB_NOT_FOUND`, and `VALIDATION` per §5.7.

**Ordering commitment.** M1/M2/M3 can only land in order — M3 without M2 would
serialize `INTERNAL` for every real failure mode, defeating the taxonomy. M4 can land in
the same PR as M3 at the maintainer's option; splitting is recommended to keep each
reviewable.

## 11. Success metrics

### 11.1 Structural (enforced in tests)

- **S1.** Every throw in `src/` (outside `src/errors.ts`) produces a `KBError` or is
  caught and re-thrown as `KBError`. Enforced by a test in M3 that walks
  `handleListKnowledgeBases` and `handleRetrieveKnowledge` via table-driven scenarios
  (injected `FaissIndexManager` mocks that throw each code) and asserts the resulting
  wire payload parses to a `KBError` shape with the expected `code`.
- **S2.** Every MCP-error response is JSON-parseable. Test: `JSON.parse(result.content[0].text)`
  succeeds when `result.isError === true`, and the parsed object matches the §5.4 schema
  exactly (no extra top-level keys, required fields present).
- **S3.** `code` set is exactly the `KBErrorCode` union from `src/errors.ts`. A lint-style
  test enumerates the scenarios and asserts every emitted `code` is a union member;
  rejects codes introduced outside the union.

### 11.2 Negative (also enforced)

- **N1.** No absolute path in **either** `error.message` or `error.hint`. Test: run each
  error scenario with `KNOWLEDGE_BASES_ROOT_DIR` / `FAISS_INDEX_PATH` set to distinctive
  sentinel values (e.g. `/tmp/rfc009-sentinel-root`), assert the sentinel string does
  not appear in *any* string field under `error` (`message`, `hint`, and — defensively
  — any unknown future string field). **Load-bearing coverage:** the assertion is
  non-trivially exercised by `PERMISSION_DENIED`, `DISK_FULL`, and the `INTERNAL`
  fallback (the three codes whose throw sites naturally compose messages around
  filesystem paths); for `INDEX_NOT_INITIALIZED`, `PROVIDER_*`, `KB_NOT_FOUND`, and
  `CORRUPT_INDEX` the assertion is defensive and passes trivially. Document the
  split in the test so a future reviewer does not mistake trivial passes for
  meaningful coverage.
- **N2.** No `*_API_KEY` value in any string field under `error` (`message`, `hint`,
  or any future string field). Test (two parts):
  (a) seed each provider's env var with a sentinel
  (`OPENAI_API_KEY=OPENAI_SENTINEL_VALUE_DO_NOT_LEAK`), trigger the missing-key and
  runtime-401 throw paths, assert the sentinel is not anywhere in the wire payload;
  (b) **provider-echo variant** — inject a synthetic `Error` whose `.message` contains
  `"Authorization: Bearer SENTINEL_BEARER_DO_NOT_LEAK"` into the catch at
  `src/FaissIndexManager.ts:388-396`, assert the sentinel is not in the wire payload.
  This exercises the "never copy `cause.message` into the public message" rule (§5.6)
  independently from any real provider SDK's current behaviour. Server stderr is
  allowed to contain the env-var name but not the value; this is a separate log-hygiene
  property checked by the existing logger tests.
- **N3.** No `stack`, no `cause`, no extra top-level keys under `error`. Test:
  `Object.keys(JSON.parse(text).error).sort()` is a subset of
  `['code','message','transient','hint']`. Plus a regex assertion that the wire payload
  contains no stack-frame marker (`/\n\s+at /`) — catches the edge case where a throw
  site accidentally passes `err.stack` as the `message` even though the top-level shape
  remains well-formed.

### 11.3 Coverage

- **C1.** Every code in §5.2's table has at least one unit test that exercises its throw
  path (real or injected) and asserts the wire payload. `INTERNAL` is covered via a
  "throw a plain `Error`" injection.

### 11.4 Non-numeric (post-release observations; not merge gates)

- Any GitHub issue filed in the 30 days after M3 lands that says "my MCP client broke on
  the error payload" is treated as a priority-1 regression — M4's migration guidance is
  re-examined and either the README doc is clarified or the wire shape is revisited.

## 12. Implementation checklist

Each item maps to a single PR unless noted. Stages mirror §10.

### M1 — `feat(errors): introduce KBError + classification helpers`

- [ ] **M1.1** Create `src/errors.ts` with `KBError` class, `KBErrorCode` union (§5.1, §5.2),
      and the `DEFAULT_TRANSIENT: Record<KBErrorCode, boolean>` map.
- [ ] **M1.2** Move `isPermissionError` from `src/FaissIndexManager.ts:42-48` into
      `src/errors.ts`. Re-export from the original location in `FaissIndexManager.ts` for
      one release to avoid a wide import diff; mark the re-export `@deprecated` in a
      comment — actual deletion is part of M2.
- [ ] **M1.3** Add `classifyFsError(error): KBErrorCode` mapping `EACCES|EPERM|EROFS →
      PERMISSION_DENIED`, `ENOSPC → DISK_FULL`, else `INTERNAL`. KB-scoped `ENOENT →
      KB_NOT_FOUND` classification is a separate helper `classifyKbPathError`,
      invoked only from KB-resolution sites (added in M2 alongside the callers).
- [ ] **M1.4** Add `serializeErrorForMcp(error: unknown): CallToolResult` per §5.5 rule 3.
      `CallToolResult` is imported from `@modelcontextprotocol/sdk/types.js` (same import
      path as `src/KnowledgeBaseServer.ts:5`).
- [ ] **M1.5** `src/errors.test.ts`: unit tests for (a) `KBError` constructor defaults
      match the §5.2 table, (b) `classifyFsError` maps each code, (c)
      `serializeErrorForMcp` strips `cause`/`stack`, (d) `serializeErrorForMcp` wraps
      non-`KBError` as `INTERNAL` with the generic message (§5.5 rule 5), (e) payload is
      round-trip JSON-parseable, (f) `hint` is omitted when absent.
- [ ] **M1.6** No behaviour change in `src/FaissIndexManager.ts` or `src/KnowledgeBaseServer.ts`.
      `npm test` and `npm run build` must pass.

### M2 — `refactor(errors): classify throw sites in FaissIndexManager`

- [ ] **M2.1** `src/FaissIndexManager.ts:99-101` → `throw new KBError('PROVIDER_AUTH',
      'OPENAI_API_KEY is not set.', { hint: 'Set OPENAI_API_KEY and restart.', transient: false })`.
      Same treatment for `src/FaissIndexManager.ts:110-113` (`HUGGINGFACE_API_KEY`).
- [ ] **M2.2** Replace the plain-`Error` construction in the permission branch of
      `handleFsOperationError` at `src/FaissIndexManager.ts:59-63` with `new
      KBError('PERMISSION_DENIED', <public-safe message>, { cause: error, hint: 'Grant
      write access to the target directory and retry.' })`. Add a `toPublicPath(abs)`
      helper that reduces `FAISS_INDEX_PATH` / `KNOWLEDGE_BASES_ROOT_DIR`-rooted paths to
      short tags (`<FAISS index dir>` / `<KB root>/<kb>/...`).
- [ ] **M2.3** In the generic branch of `handleFsOperationError` (`src/FaissIndexManager.ts:65-77`),
      call `classifyFsError(error)` and construct `new KBError(code, <public message>,
      { cause: error })`. Preserve `__alreadyLogged` behaviour.
- [ ] **M2.4** `src/FaissIndexManager.ts:403-405` (`similaritySearch` guard) → `throw new
      KBError('INDEX_NOT_INITIALIZED', 'The FAISS index has not been built yet.', {
      transient: true, hint: 'Retry after updateIndex() completes.' })`.
- [ ] **M2.5** `src/FaissIndexManager.ts:171-188` corrupt-index path: on rebuild-failure
      (the `unlink` at `:181` or the subsequent `save` failing), classify as
      `KBError('CORRUPT_INDEX', …)`. The successful-recovery path stays a warn-log.
- [ ] **M2.6** Add `classifyProviderError(error)` to `src/errors.ts` (promoted from §5.7)
      and call it in the catch at `src/FaissIndexManager.ts:388-396` to wrap provider-SDK
      errors into `PROVIDER_TIMEOUT` / `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMIT` /
      `PROVIDER_AUTH` (runtime variant).
- [ ] **M2.7** `src/FaissIndexManager.test.ts`: for each throw site, assert the thrown
      error `instanceof KBError` and `.code === <expected>`. Include a negative test that
      the `cause` chain preserves the original error.
- [ ] **M2.8** Remove the `src/FaissIndexManager.ts` re-export of `isPermissionError`
      added in M1.2 (single minor-release deprecation window is fine pre-1.0).

### M3 — `feat(errors): serialize KBError at the MCP boundary`

- [ ] **M3.1** Replace the ad-hoc construction at `src/KnowledgeBaseServer.ts:66-70` with
      `return serializeErrorForMcp(error);`. Same at `src/KnowledgeBaseServer.ts:119-120`.
      Keep the `logger.error` + `logger.error(error.stack)` calls unchanged — server logs
      are unaffected by this RFC.
- [ ] **M3.2** `src/KnowledgeBaseServer.test.ts`: integration-style tests that drive
      `handleListKnowledgeBases` / `handleRetrieveKnowledge` with an injected
      `FaissIndexManager` mock configured to throw each taxonomy code; assert the wire
      payload `JSON.parse(result.content[0].text).error` matches `{ code, message,
      transient, hint? }` with the expected shape.
- [ ] **M3.3** Leak tests per §11.2 N1/N2 wired here (not in M1) because M1's helper has
      no caller context to drive them realistically.
- [ ] **M3.4** Schema test per §11.2 N3 (including the stack-frame-regex assertion).
- [ ] **M3.5** **Required migration of existing tests.** `src/KnowledgeBaseServer.test.ts:108`
      and `:196` assert on the current English prose (`/^Error listing knowledge bases:/`
      and `/^Error retrieving knowledge:/`). Update both to parse the JSON payload and
      assert `error.code === 'INTERNAL'` (since both cases inject a generic `Error`,
      which takes the `INTERNAL` fallback per §5.5 R5). Land the test update in the
      same PR as the wire-shape flip so the suite is never broken on `main`.

### M4 — `docs(errors): README "MCP error codes" + CHANGELOG migration note`

- [ ] **M4.1** Add a "MCP error codes" section to `README.md` under the existing MCP-tool
      documentation. For each code: transience default, one-sentence meaning, example
      payload. The §6 examples in this RFC are the starting point.
- [ ] **M4.2** `CHANGELOG.md` entry under `[Unreleased] Changed`: before/after payload
      for `list_knowledge_bases` error and `retrieve_knowledge` error; the grep-for
      guidance (`"Error listing knowledge bases:"`, `"Error retrieving knowledge:"`);
      the "unknown code ⇒ treat as `INTERNAL`" rule; a short code table.
- [ ] **M4.3** Link from `CLAUDE.md` → new README section (one-liner under the "Working on
      this repo" subsection) so future agent runs find the taxonomy without re-discovery.

### M5 (optional) — `feat(errors): typed error surface for HTTP transport`

- [ ] **M5.1** Land only after RFC 008 ships an HTTP listener. Adds `HttpTransportError`
      in `src/transport/HttpTransportHost.ts` (per RFC 008 §11 layout; separate class
      from `KBError`) for the `401`/`403`/`500` paths. Does not change the MCP-tool
      error path. §7's separation is preserved and documented in the PR description.

### Housekeeping (opportunistic)

*(M3.5 now explicitly covers the test migration that was previously flagged here. This
section is intentionally empty; add new housekeeping items as they arise.)*

---

*End of RFC 009.*
