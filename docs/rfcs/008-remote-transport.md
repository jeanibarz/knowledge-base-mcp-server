# RFC 008 — Remote transport (SSE + streamable-http)

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 006 (multi-provider retrieval — overlaps on MCP tool surface), RFC 007 (architecture & performance — overlaps on per-KB index isolation and the single-process-per-`FAISS_INDEX_PATH` invariant)

## 1. Summary

The server speaks MCP exclusively over stdio — `new StdioServerTransport()` at
`src/KnowledgeBaseServer.ts:126` is the only transport seam. The current
distribution model is therefore "one client process launches one server as a
child and owns the stream"; Smithery remote mode, browser-based MCP clients,
and any shared/team deployment cannot connect. This RFC proposes adding two
additional transports — Server-Sent Events (SSE) and Streamable HTTP — behind
an `MCP_TRANSPORT` env flag that keeps stdio as the default. The interesting
work is not the transport plumbing (the classes already ship in
`@modelcontextprotocol/sdk@^1.17.2` per `package.json:23`) but the
cross-cutting concerns around it: per-session transport lifecycle that
matches the SDK's own shape, bearer-token authn with a constant-time
compare, CORS that agrees with the SDK's DNS-rebinding check, graceful
shutdown integrated with the existing SIGINT handler
(`src/KnowledgeBaseServer.ts:27-30`), stderr-only access logging that
preserves the logger's invariant (`src/logger.ts:16`), a loopback-only
default bind address, and an unauthenticated `/ready` probe. Work ships in
six PRs across four phases; stdio remains the untouched default throughout.

## 2. Motivation

### 2.1 Evidence from code

- `KnowledgeBaseServer.run` instantiates exactly one transport class —
  `StdioServerTransport` at `src/KnowledgeBaseServer.ts:126` — and wires it
  to `McpServer.connect`. There is no selection seam; no env var governs the
  choice. Every MCP client that wants to talk to this server must be able to
  spawn it as a child process and own stdin/stdout.
- The SIGINT handler at `src/KnowledgeBaseServer.ts:27-30` calls
  `this.mcp.close()` synchronously and then `process.exit(0)`. It is the
  only shutdown path. There is no SIGTERM handler and no notion of
  in-flight request drain — both fine for stdio (the client owns the
  process), but insufficient for a long-lived HTTP listener that must
  answer a supervisor's or load balancer's graceful-shutdown signal.
- The logger at `src/logger.ts:16` initialises `destinations` to
  `[process.stderr]` and optionally appends a `LOG_FILE` stream. Nothing
  writes to stdout, by design — stdio JSON-RPC frames would be corrupted
  otherwise (the invariant is called out in `CLAUDE.md` and was the subject
  of a prior landed fix). Any HTTP access log this RFC introduces must
  respect that invariant even though the stdout-corruption risk disappears
  under HTTP.
- The MCP tool surface is registered in `KnowledgeBaseServer.setupTools()`
  (`src/KnowledgeBaseServer.ts:33-50`) and is transport-agnostic:
  `McpServer` exposes the same two tools (`list_knowledge_bases`,
  `retrieve_knowledge`) over any `Transport` implementation. **No
  tool-code changes are required** by this RFC; the work is strictly at
  the transport layer and below. RFC 006's proposed `reload_config` tool
  and RFC 007's proposed `refresh_knowledge_base` tool compose trivially
  — the transport layer never inspects the tool list (§6.9).
- `@modelcontextprotocol/sdk@^1.17.2` (`package.json:23`) already ships
  both transport classes this RFC needs. Verified:
  `node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.d.ts:30-73`
  declares `SSEServerTransport(endpoint, res, options?)`;
  `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts:113-132`
  declares `StreamableHTTPServerTransport({ sessionIdGenerator,
  allowedHosts, allowedOrigins, enableDnsRebindingProtection,
  enableJsonResponse, ... })`. Both implementations include built-in
  DNS-rebinding protection via host/origin allow-lists; this RFC uses
  those facilities as a second line of defence behind our own bearer-auth
  + CORS layer (§6.4 documents how the two layers are kept in agreement).

### 2.2 Evidence from the competitive audit (issue #48)

Quoting issue #48 verbatim:

> This is the single biggest distribution-channel gap identified in a
> competitive audit:
> - `qdrant-mcp` supports **stdio + SSE + streamable-http** from the same
>   binary.
> - This repo supports stdio only.
> - Multi-user / team KBs, hosted deployments, and browser clients are all
>   blocked.

The repo is a spiritual peer of `qdrant-mcp` — a single-binary MCP server
that wraps a vector store and exposes retrieval tools. Every concrete
deployment mode `qdrant-mcp` supports and this repo does not is a user who
cannot adopt this repo without switching tools. The `package.json:23`
dependency already carries the code to close that gap.

### 2.3 Use cases currently blocked

1. **Smithery remote mode.** Smithery's hosted runtime expects an HTTP
   endpoint it can proxy to; it cannot spawn a stdio process inside its own
   sandbox for third-party servers. `smithery.yaml` currently defines a
   stdio-only deploy — an SSE/HTTP transport unlocks the remote-mode path.
2. **Browser-based MCP clients.** A browser cannot open a pipe to a local
   process; it can open `fetch()` and `EventSource`. Every browser-based
   MCP client needs either SSE or streamable HTTP.
3. **Shared team KBs.** A single machine hosting a knowledge base that
   several teammates want to query today needs one local server process
   per teammate — each with its own `FAISS_INDEX_PATH` (see §6.9 for why
   that constraint is *unchanged* by this RFC) or coordinated stdio
   fan-out tooling that does not exist. An HTTP-addressable server is the
   natural "one KB, many clients" shape.
4. **Hosted-agent infrastructure.** Any orchestrator that runs MCP clients
   on disposable workers (CI lanes, sandboxed agents, lambda-style
   functions) cannot co-locate a stdio child; it wants a URL.

## 3. Goals

- G1. **Opt-in remote transports** — users can set `MCP_TRANSPORT=sse` or
  `MCP_TRANSPORT=http` and have the server answer on a configurable port.
- G2. **Stdio is the unchanged default** — existing deploys (Claude
  Desktop, Codex, Cursor, Cline) continue to work with zero new
  configuration. Users who never set `MCP_TRANSPORT` see **no observable
  behavior change** — the stdio code path in `run()` stays byte-identical
  to today, including startup-log ordering.
- G3. **Secure by default for non-stdio transports** — server refuses to
  start in `sse`/`http` mode without a bearer token, binds to loopback
  only by default, and rejects cross-origin requests from unlisted
  origins.
- G4. **Graceful shutdown** — SIGTERM and SIGINT both stop accepting new
  connections, drain in-flight MCP requests with a bounded deadline, then
  close.
- G5. **Transport-agnostic tool surface** — `list_knowledge_bases` and
  `retrieve_knowledge` behave identically over any transport. No
  tool-layer changes; RFC 006 and RFC 007 tool additions compose without
  transport modification.

## 4. Non-goals

- **Multi-tenancy beyond "a single shared bearer token gates access".** No
  per-user scoping, no per-user KBs, no user model. A v1 deployment is
  "trusted-network or trusted-team" — the bearer token is the coarse
  gate. Per-user access is a separate RFC.
- **Rate limiting / quota enforcement.** Not in v1. The embedding-provider
  rate limits are the backstop today; upstream DoS concerns are flagged
  in §8 but not closed by this RFC.
- **TLS termination.** Out of scope — the server binds plain HTTP on
  loopback by default. Users who expose the endpoint publicly must
  terminate TLS with a reverse proxy (nginx, Caddy, Cloudflare Tunnel).
  Documented in §8.
- **Authentication schemes beyond bearer token in v1.** OAuth, mTLS, SSO,
  pluggable auth backends — all deferred. Flagged in §7 and §8; this RFC
  does not pre-commit to any.
- **Cookie-based authentication.** Not in v1. All authentication is via
  `Authorization: Bearer`; the server does not read cookies. A future RFC
  that adds cookie auth (e.g. for browser `EventSource` ergonomics per
  §7.6) must also introduce CSRF defence (SameSite, double-submit, or
  custom-header). This non-goal exists to pre-empt a silent regression.
- **Unauthenticated `/health` detail endpoint.** v1 ships only `/ready`
  (unauthed liveness, §6.8). Operators who want version/uptime/provider
  detail must read it from the process (env, logs, `ps`). A
  `/health/detail` behind auth is a natural follow-up but is not
  load-bearing for v1 (see §8.3 discussion).
- **Persistent sessions with cross-process resumability.** Streamable
  HTTP's `EventStore` slot (per `streamableHttp.d.ts:10-21`) is left
  unset in v1 — resumability would require a shared store (Redis,
  SQLite) and interacts with the single-process-per-`FAISS_INDEX_PATH`
  rule (§6.9). v1 ships stateful in-memory mode only; stateless mode is
  deferred (see §7.7).
- **Transport hot-swap.** `MCP_TRANSPORT` is read once at startup. No
  runtime change of transport without a restart. The deploy unit is a
  single transport.
- **WebSocket transport.** Not a protocol-spec MCP transport at time of
  writing; see §7.4.
- **HTTP/2.** `node:http` is HTTP/1.1 by default; HTTP/2 is deferred. If
  HTTP/2 is wanted, it is terminated by the reverse proxy.
- **IPv6 default bind.** The `127.0.0.1` default is IPv4-only; operators
  who want `::1` or dual-stack set `MCP_BIND_ADDR=::` explicitly.
- **Horizontal replicas on one index.** Running N server processes against
  the same `FAISS_INDEX_PATH` is not supported in v1 (see §6.9 and issue
  #44). Horizontal scaling requires N distinct index paths.

## 5. Current state (observed)

The only code path worth baselining is the one the RFC replaces. The
`run()` method at `src/KnowledgeBaseServer.ts:124-136` is a straight line:

1. Construct `new StdioServerTransport()`.
2. `await this.mcp.connect(transport)`.
3. `logger.info('Knowledge Base MCP server running on stdio')`.
4. `await this.faissManager.initialize()`.

There is no branch. Shutdown is the SIGINT handler at
`src/KnowledgeBaseServer.ts:27-30`:

```ts
process.on('SIGINT', async () => {
  await this.mcp.close();
  process.exit(0);
});
```

No drain loop, no SIGTERM handler, no observation that `mcp.close()` might
take non-trivial time under an HTTP transport (for stdio it is effectively
instantaneous — closing stdin unblocks the read loop). Everything this RFC
proposes touches at most these two blocks and the env/config surface in
`src/config.ts:1-41` that feeds them.

### 5.1 Measurements deferred

Wall-time measurements of the current stdio path are unnecessary for this
RFC: the proposal is additive and the stdio path is unchanged. A single
latency target for the new HTTP path is set in §10.2 as a non-blocking
warn-only CI gate. Structural targets (§10.1) are the primary merge
criteria. This mirrors RFC 007 §5.5's "measurements blocked / deferred"
framing — the limitation is called out rather than hand-waved.

## 6. Proposed design

The work lives in two new files (auth helper + HTTP-layer wrapper), small
edits to `src/KnowledgeBaseServer.ts`, and additions to `src/config.ts`.
No tool-code changes, no FAISS changes, no logger behavior change.

### 6.1 Environment surface

New env vars. Validation rules are **part of the contract** and are tested
in PR 2a (§11):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | One of `stdio`, `sse`, `http`. Invalid → refuse to start. |
| `MCP_PORT` | `8765` | TCP port for `sse`/`http`. Integer in `[1, 65535]`. Ignored under `stdio`. |
| `MCP_BIND_ADDR` | `127.0.0.1` | Bind address for the HTTP listener. Loopback by default. Ignored under `stdio`. |
| `MCP_AUTH_TOKEN` | *(unset)* | Bearer token required in `Authorization: Bearer <token>`. **Unset under `sse`/`http` → refuse to start** (§6.3). Must be ≥32 bytes; shorter tokens abort startup. Ignored under `stdio`. |
| `MCP_ALLOWED_ORIGINS` | *(unset)* | Comma-separated list of allowed `Origin` values. Each entry must be a full origin per RFC 6454 (`scheme://host[:port]`, no path, no trailing slash). **Unset = deny all** browser origins. Wildcard `*` is **rejected**. Ignored under `stdio`. |
| `MCP_ALLOWED_HOSTS` | *(computed)* | Comma-separated list of allowed `Host` header values (for DNS-rebinding defence). Default: `127.0.0.1:<MCP_PORT>,localhost:<MCP_PORT>`. Operators behind a reverse proxy set this to the public hostname(s) the proxy presents, e.g. `knowledge.example.com`. Ignored under `stdio`. |
| `MCP_SHUTDOWN_DEADLINE_MS` | `10000` | Maximum wait for in-flight MCP requests to drain before forcing close. |
| `MCP_MAX_SESSIONS` | `1000` | Maximum concurrent active sessions (SSE) / active streamable-HTTP transports. Beyond this, new session requests return `503 Service Unavailable`. Bounds memory (§8.1 R4). |

**Validation and startup refusal contract.** Invalid env combinations are
caught before `KnowledgeBaseServer` is constructed. Every failure aborts
with a non-zero exit, a stderr log, and no partial state on disk. Each
rule below is one test case in PR 2a checklist item 2a.2:

- `MCP_TRANSPORT` not in the supported set → `Invalid MCP_TRANSPORT='<value>'; expected one of stdio|sse|http`.
- `MCP_TRANSPORT ∈ {sse, http}` and `MCP_AUTH_TOKEN` unset/empty →
  `MCP_TRANSPORT=<value> requires MCP_AUTH_TOKEN to be set`.
- `MCP_TRANSPORT ∈ {sse, http}` and `MCP_AUTH_TOKEN.length < 32` →
  `MCP_AUTH_TOKEN must be at least 32 characters (generate with 'openssl rand -base64 32')`.
  There is no short-token escape hatch in v1.
- `MCP_PORT` not in `[1, 65535]` → abort with the parsed value in the
  message.
- `MCP_TRANSPORT=stdio` with `MCP_AUTH_TOKEN` unset → **accepted**; stdio
  has no authn surface. This case is called out so the matrix is
  unambiguous.
- `MCP_ALLOWED_ORIGINS='*'` → **rejected** with a message pointing to
  §7.6. A user who genuinely wants "any origin" means "no auth" (public
  read-only KB), which is out of scope for v1.
- `MCP_ALLOWED_ORIGINS` entries that don't parse as an origin →
  rejected (normalization: lowercase scheme and host, default port
  stripped, no path, no trailing slash).
- `MCP_TRANSPORT=stdio` with any HTTP-only var set (`MCP_PORT`,
  `MCP_BIND_ADDR`, `MCP_AUTH_TOKEN`, `MCP_ALLOWED_ORIGINS`,
  `MCP_ALLOWED_HOSTS`, `MCP_MAX_SESSIONS`) → **accepted** but logs a
  single `warn` line at startup listing the ignored vars, so
  `MCP_TRANSPORT=stdoi` typos do not silently eat the rest of the
  config.

### 6.2 Transport wiring

Today (`src/KnowledgeBaseServer.ts:124-136`):

```ts
async run() {
  const transport = new StdioServerTransport();
  await this.mcp.connect(transport);
  logger.info('Knowledge Base MCP server running on stdio');
  await this.faissManager.initialize();
}
```

Proposed:

```ts
async run() {
  switch (config.MCP_TRANSPORT) {
    case 'stdio':
      return this.runStdio();                 // byte-identical to today
    case 'sse':
      await this.faissManager.initialize();   // block HTTP bind on ready index
      return this.runHttpListener('sse');
    case 'http':
      await this.faissManager.initialize();
      return this.runHttpListener('http');
  }
}
```

**Why `initialize()` moves only on the HTTP branch.** Under stdio the
client owns the process and typically serializes its first call behind
the handshake, so today's order (connect → initialize) works. Under HTTP
the listener binds as soon as `createServer().listen()` returns, and a
client reaching the server sub-second later would race the index load
(observable symptom: a `retrieve_knowledge` call returning "no results"
against a KB that exists on disk, since `handleRetrieveKnowledge` at
`src/KnowledgeBaseServer.ts:84` calls `updateIndex` on a not-yet-ready
manager). Blocking the HTTP bind on `initialize()` closes that race.
Keeping stdio's order untouched preserves G2 ("stdio is the unchanged
default"). Stdio users who find they actually care about the same race
can opt into the new order in a follow-up RFC; no evidence it is hit
today.

**`runStdio()`** is the current body of `run()`, lines 125-129 of
`src/KnowledgeBaseServer.ts`, moved to a method. **No behavior change.**

**`runHttpListener(mode)`** lives in a new file,
`src/transport/HttpTransportHost.ts`. Its responsibilities are laid out
in §6.2.1–§6.2.3 below. The split between SSE and streamable-HTTP is
load-bearing: each shape needs a different transport lifecycle.

#### 6.2.1 Request pipeline (both modes)

For every incoming request, in order, the wrapper:

1. **Handle `OPTIONS` preflight.** §6.4 — short-circuits with CORS
   headers and `204`, never reaches auth. No `inFlight` increment.
2. **Handle `GET /ready`.** §6.8 — returns `200 OK` with
   `{"status":"ok"}`. No auth. No `inFlight` increment. A richer
   authed `/health/detail` endpoint is deferred per §4 non-goals
   and §11 follow-ups.
3. **Validate the `Host` header** against `MCP_ALLOWED_HOSTS`.
   Mismatch → `421 Misdirected Request`, log `host=invalid`, return.
   No `inFlight` increment.
4. **Validate the `Origin` header** against `MCP_ALLOWED_ORIGINS`
   (§6.4). Unlisted → `403`, log `origin=invalid`, return. Missing
   `Origin` is handled by §6.4's policy — see there.
5. **Validate `Authorization: Bearer <token>`** (§6.3). Missing/mismatch
   → `401` with `WWW-Authenticate: Bearer`, log `auth=…`, return. No
   `inFlight` increment.
6. **Gate on shutdown flag.** If `shuttingDown` is set, return `503
   Service Unavailable` with `Retry-After: 0` and log
   `status=503,reason=shutting_down`. Returns before `inFlight`
   increment — guarantees `inFlight` is monotonically non-increasing
   after the flag flips (§6.5).
7. **Increment `inFlight` (for dispatched requests only)** — see §6.5
   for the exclusion list (pre-auth rejections, SSE GET open itself,
   `/ready`).
8. **Dispatch to the transport** — §6.2.2 (SSE) or §6.2.3
   (streamable-HTTP).
9. **`finally` block decrements `inFlight`** (not for SSE GET; see
   §6.2.2).

**Body parsing.** The wrapper **does not** read the request body
itself. It hands the raw `req` to the SDK's dispatch calls
(`transport.handlePostMessage(req, res)` for SSE,
`transport.handleRequest(req, res)` for streamable-HTTP), and the SDK
applies its built-in `getRawBody` 4 MB cap (verified at
`node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js`
and `sse.js` body-parsing paths). Oversized bodies return `413 Payload
Too Large` from the SDK. This explicitly rules out a future implementer
adding a naive `req.on('data')` accumulator that would OOM the server.

#### 6.2.2 SSE transport — one transport per connection

Per the SDK (`sse.d.ts:30-73`), `SSEServerTransport` takes a
`ServerResponse` in its constructor; each client's long-lived GET stream
is one instance, and POSTs from the same client go through
`handlePostMessage` on the *same* instance, routed by the session id
the SDK generates.

The wrapper owns a `Map<string, SSEServerTransport>` keyed by
`transport.sessionId`.

**`GET /sse` flow:**

1. **Refuse during shutdown.** If `shuttingDown` is set → `503 Service
   Unavailable` with `Retry-After: 0`. The §6.2.1 step 6 gate covers
   dispatch but not SSE-GET specifically, so this refusal must be
   repeated in the SSE branch to avoid accepting a new long-lived stream
   that the shutdown sweep would then immediately close.
2. Reserve a slot: if `sessions.size >= MCP_MAX_SESSIONS` → `503`,
   return. Otherwise proceed. (`sessions.size` is read once; under
   extreme concurrency the cap is a soft +1 in the worst case — the
   implementation may use a counter variable incremented before insert
   to tighten this, at the cost of complexity. The soft cap is
   acceptable — see §8.1 R4.)
3. Construct `newTransport = new SSEServerTransport('/messages', res,
   sseOptions)` where `sseOptions` mirrors the wrapper's configured
   host/origin allow-lists (see §6.4 for how they're kept consistent).
4. Register cleanup **before** connecting: `newTransport.onclose = () =>
   sessions.delete(newTransport.sessionId)`. This is the blanket
   cleanup path; it fires on every close (client disconnect, wrapper-
   initiated `transport.close()`, socket error) because SSE's
   `onclose` is invoked unconditionally by the SDK
   (`sse.js:143` fires `onclose?.()` on every `close()` invocation and
   `sse.js:71-75` fires it on the `res.on('close', ...)` socket path).
5. Insert into the map **before** awaiting the connect:
   `sessions.set(newTransport.sessionId, newTransport)`. This avoids
   the insert-vs-close race where `onclose` fires after `connect()`
   resolves but before the map insertion.
6. `await this.mcp.connect(newTransport)`. The SDK calls `start()`
   internally, which writes the SSE preamble and registers its own
   `res.on('close', ...)` handler.
7. `inFlight` is **not** incremented for the open SSE GET itself — the
   connection is held open for minutes to hours and would always
   trigger `MCP_SHUTDOWN_DEADLINE_MS` on exit. `inFlight` tracks the
   per-`POST /messages` dispatch, not the stream open. On shutdown,
   live SSE streams are closed via `transport.close()` after the
   drain (§6.5), which causes any connected client to reconnect; this
   is the intended protocol behavior.

**`POST /messages?sessionId=<id>` flow:**

1. Validate `sessionId` matches a UUID shape regex
   (`/^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/`
   — fully anchored, 36-char fixed length, no nested quantifiers → no
   ReDoS risk; loose-in-version-nibble so the regex survives a future
   SDK bump from UUID-v4 to v7). Non-match → `400 Bad Request`, log
   `session=malformed`. Defends against log-injection via an
   attacker-controlled `sessionId` that never makes it into the log
   line raw.
2. Look up in `sessions`. Miss → `404 Not Found`, log
   `session=unknown`. Hit → increment `inFlight`, call `await
   transport.handlePostMessage(req, res)`, decrement in `finally`.

#### 6.2.3 Streamable HTTP transport — one transport per session

Per the SDK (`streamableHttp.d.ts:113-132`), a single
`StreamableHTTPServerTransport` instance owns one `sessionId` and will
reject any subsequent `initialize` request on the same instance with
`"Invalid Request: Server already initialized"` (verified at
`streamableHttp.js:325-334`). A process-wide singleton therefore serves
only one client. The canonical per-session pattern is documented in the
SDK's own example at
`node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/jsonResponseStreamableHttp.js:69-111`.

**v1 ships stateful mode only.** Every transport instance is constructed
with `sessionIdGenerator: () => crypto.randomUUID()` (which meets the
SDK's guidance at `streamableHttp.d.ts:28-32` for cryptographically
secure session ids). The `EventStore` slot (`streamableHttp.d.ts:10-21`)
is left unset; resumability is a non-goal (§4). Stateless mode
(`sessionIdGenerator: undefined` per `streamableHttp.d.ts:32`) is not
wired in v1 — deferred to a follow-up RFC (§7.7) because it introduces
a separate lifecycle (per-request transport construction) with its own
test matrix.

The wrapper owns a `Map<string, StreamableHTTPServerTransport>` keyed by
`sessionId`, mirroring the SSE map.

**Request flow:**

1. Extract `sessionId` from the `Mcp-Session-Id` request header (the SDK
   protocol's header for session routing). If the header is present,
   validate against the same UUID-shape regex as §6.2.2 POST step 1
   before any further processing (log-injection defence).
2. **Branch on session id + method:**
   - **Absent `sessionId` AND POST AND body.method == `initialize`** →
     mint a new session (step 3).
   - **Absent `sessionId` AND body.method ≠ `initialize`** → `400 Bad
     Request` with body `{"error":"No valid session id; non-initialize
     method requires Mcp-Session-Id header"}`, log `session=absent`.
     This is the branch the SDK's canonical example handles at
     `simpleStreamableHttp.js:467-477` / `jsonResponseStreamableHttp.js:98-108`.
   - **Present `sessionId` AND body.method == `initialize`** → this is
     a misbehaved client. Treated as unknown-id: `404`, log
     `session=unknown,hint=spurious_session_on_initialize`. The
     wrapper does **not** mint a new session on this path because the
     client's header indicates confusion that the caller needs to
     surface.
   - **Present `sessionId` AND body.method ≠ `initialize`**
     (including `DELETE`) → step 4.
3. **Mint path** (absent id, initialize): refuse during shutdown
   (§6.2.1 step 6 catches this before step 2, so this note is for
   completeness). Reserve a slot (`sessions.size < MCP_MAX_SESSIONS`
   or 503). Construct:

   ```ts
   const newTransport = new StreamableHTTPServerTransport({
     sessionIdGenerator: () => crypto.randomUUID(),
     onsessioninitialized: (id) => { sessions.set(id, newTransport); },
     allowedHosts, allowedOrigins,
     enableDnsRebindingProtection: true,
   });
   newTransport.onclose = () => {
     if (newTransport.sessionId) sessions.delete(newTransport.sessionId);
   };
   ```

   The `onclose` wiring is load-bearing: the SDK's `_onsessionclosed`
   callback fires **only** inside `handleDeleteRequest`
   (`streamableHttp.js:435-446`); every other close path (client TCP
   drop, wrapper-initiated `transport.close()` on shutdown, handshake
   error) fires `onclose` (`streamableHttp.js:535`) but not
   `_onsessionclosed`. Without the `onclose` map-delete, the wrapper's
   session map leaks one entry per disconnecting client. The canonical
   SDK example at
   `node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js:442-459`
   uses the same dual-wire pattern.

   Then `await this.mcp.connect(newTransport)` and `await
   newTransport.handleRequest(req, res)`. The closure over
   `newTransport` in `onsessioninitialized` resolves at callback-fire
   time (inside `handleRequest`, after construction); this is the
   pattern the SDK example uses.

   **Handshake error cleanup.** If `handleRequest` throws during the
   initial `initialize` call *after* `onsessioninitialized` has fired
   and inserted into the map, the map-delete runs via the `onclose`
   wiring when the transport eventually closes (either via the SDK's
   internal teardown or via the request `res.on('close')`). Worst-case,
   a dead transport sits in `sessions` until either `MCP_MAX_SESSIONS`
   pushes it out or the client DELETEs; this is acceptable.
4. **Route path** (present id, non-initialize): look up in the map.
   Miss → `404`, log `session=unknown`. Hit → `await
   transport.handleRequest(req, res)` (the SDK handles GET, POST,
   DELETE internally). `DELETE` with a valid id triggers the SDK's
   `handleDeleteRequest`, which fires `_onsessionclosed`; the `onclose`
   wiring then fires too, deleting the map entry (idempotent for
   double-delete — see §6.5 idempotency note).

**Multi-client support.** Because step 2 branches on absent session
id + initialize → mint new, multiple concurrent clients each minting
their own session are supported: each runs in its own
`StreamableHTTPServerTransport` instance. §10.1 pins this with a
"second-client initialize" CI row.

**Why map ownership lives in the wrapper, not the SDK.** The SDK
provides the per-session lifecycle callbacks
(`onsessioninitialized`/`onsessionclosed`) and the session-id
generator, but it does not dispatch requests to the right transport
given an incoming `Mcp-Session-Id`. That routing is the wrapper's job;
the SDK expects the wrapper to own the map.

#### 6.2.4 SDK-level DNS-rebinding protection (belt-and-braces)

Both `SSEServerTransport` (per `sse.d.ts:14-24`) and
`StreamableHTTPServerTransport` (per `streamableHttp.d.ts:67-77`)
accept `allowedHosts`, `allowedOrigins`, and
`enableDnsRebindingProtection: true`. The wrapper passes all three:

- `allowedHosts` = parsed `MCP_ALLOWED_HOSTS`.
- `allowedOrigins` = parsed `MCP_ALLOWED_ORIGINS`.
- `enableDnsRebindingProtection` = `true`.

**Two layers, same allow-list.** The wrapper's own Host and Origin
checks (steps 3 and 4 of §6.2.1) happen *before* dispatch and use the
same parsed allow-lists. If the lists ever disagree (bug), the SDK
rejects conservatively; our layer would have already rejected. Tests
in §11 PR 2a checklist item 2a.4 cover the agreement contract.

**Non-browser clients and `Origin`.** The SDK's validator rejects
missing `Origin` when `allowedOrigins` is configured (verified at
`streamableHttp.js:86-91` and `sse.js:38-43`). This means curl-style
and other non-browser MCP clients must send an `Origin` header in
`sse`/`http` mode; the wrapper documents this explicitly in the PR 4
README section and in the `401` response body. The alternative —
leaving `allowedOrigins` unset on the SDK — would weaken the
DNS-rebinding defence, which is exactly the attack browser-on-loopback
enables; we accept the client-facing requirement. See §6.4 for
operator-facing wording.

### 6.3 Authentication — bearer token with constant-time compare

A new file `src/transport/auth.ts` exposes one function:

```ts
export function verifyBearer(
  authHeader: string | undefined,
  expected: string,
): boolean;
```

**Contract:**

- **The wrapper reads the token exclusively from `Authorization: Bearer`.**
  Query-string parameters, cookies, and custom headers are never parsed
  as credentials. A request with `?token=...` and no `Authorization`
  header returns `401 missing`. Non-goal §4 "Cookie-based authentication"
  pre-emptively closes the cookie-as-auth path.
- Returns `true` iff `authHeader === 'Bearer ' + expected`, byte-exact.
- Uses `crypto.timingSafeEqual` for the token-body comparison.
- Buffers are constructed with `Buffer.from(str, 'latin1')`, not
  `'utf8'`. Rationale: `'utf8'` round-trips substitute non-UTF-8 bytes
  with `U+FFFD` (three bytes), which changes length and content; a
  caller sending `Authorization: Bearer \xff\xff` could otherwise
  collide with a differently-shaped server-side token. `'latin1'`
  preserves each byte 1:1 and matches what arrives on the wire.
- Equal-length check short-circuits before `timingSafeEqual`, because
  the Node crypto API throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on
  unequal-length inputs. The `timingSafeEqual` call is also wrapped in
  a `try/catch` as belt-and-braces: if a future refactor loses the
  length check, the thrown error is swallowed into `false` rather than
  propagating to the client as a stack trace.

**Length-branch leakage — explicit.** The equal-length short-circuit
allows an attacker who can submit many requests to probe `expected`'s
length (responses differ for matching-length vs mismatched-length
probes). Because the v1 minimum is 32 bytes (§6.1) and the length is
not itself a secret (it's configuration-bounded), this leak is
acceptable. A future reviewer reading this code should not need to
re-derive the argument.

**Why constant-time even for a "low-value" token.** Without
`timingSafeEqual`, index-by-index comparison leaks the first mismatch
position; an attacker on the same host (the default bind is `127.0.0.1`,
which admits any local process) can run millions of probes per second
and reconstruct the token character-by-character in `O(n × alphabet)`.
The library-provided function is the accepted idiom; reimplementing it
is not.

**Error shape.** On any failure path, return `401 Unauthorized` with
`WWW-Authenticate: Bearer realm="knowledge-base-mcp"` and an empty
body (details help the attacker more than the operator). The access
log records `auth=missing|malformed|mismatch` (§6.6); the raw header
is **never** logged.

**Out of scope.** Token rotation, revocation, per-client tokens,
scopes, JWT. All deferred; see §7 and §8.1 R3.

### 6.4 CORS

Two layers, kept in agreement:

1. **Preflight (`OPTIONS`)** is handled by the wrapper before transport
   dispatch. Response when the request `Origin` is in
   `MCP_ALLOWED_ORIGINS`:

   ```
   HTTP/1.1 204 No Content
   Access-Control-Allow-Origin: <echoed origin>
   Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
   Access-Control-Allow-Headers: Authorization, Content-Type, Mcp-Session-Id, Last-Event-ID
   Access-Control-Max-Age: 600
   Vary: Origin
   ```

   If the `Origin` is not in the allow-list → `403 Forbidden` with no
   `Access-Control-*` headers. The browser surfaces a CORS error to
   the caller's page; the server still returns a response, so a
   developer in DevTools sees the 403 and the path forward.

2. **Non-preflight requests.** Every method except `OPTIONS` has its
   `Origin` validated against the same list. **Missing `Origin` is
   rejected under `sse`/`http` mode** — the SDK's
   `enableDnsRebindingProtection` rejects it anyway
   (`streamableHttp.js:86-91`, `sse.js:38-43`), and having the wrapper
   reject first gives a cleaner error message to the client. Non-browser
   clients in `sse`/`http` mode must send an `Origin` header matching
   `MCP_ALLOWED_ORIGINS`; the PR 4 README (§11) documents this. The
   stdio transport is unaffected.

3. **Origin allow-list is exact-match per normalized origin.** Entries
   are parsed at startup per RFC 6454: lowercase `scheme://host[:port]`,
   default port stripped (`https` → 443 omitted, `http` → 80 omitted),
   no path, no trailing slash. Malformed entries abort startup (§6.1).
   Comparison is byte-exact against the normalized form.

3a. **Host allow-list matching.** The SDK's DNS-rebinding check is a
   byte-exact `Array.includes(req.headers.host)` (verified at
   `streamableHttp.js:78-84`, `sse.js:31-38`). The wrapper's own Host
   check uses the same semantics on the same parsed list.
   Implications for `MCP_ALLOWED_HOSTS` entries: entries must include
   the port the client will send (HTTP/1.1 RFC 7230 §5.4 mandates the
   port in `Host` when it is non-default — this server's default
   `8765` is never omitted by compliant clients). Entries are
   lowercased at parse time; a crafted `Host: LocalHost:8765` is
   matched against the lowercased list. Operators behind a
   port-rewriting reverse proxy set the proxy-facing hostname with
   *that* proxy's port (e.g., `knowledge.example.com` if the proxy
   terminates at 443 and omits it per RFC 7230, or
   `knowledge.example.com:8080` otherwise).

4. **Allow-list rotation.** `Access-Control-Max-Age: 600` means a
   browser caches the preflight for up to 10 minutes; a newly-removed
   origin still gets rejected on the non-preflight path, so the
   attack window is at most 10 minutes of not-yet-rotated preflight
   cache. A newly-*added* origin may wait up to 10 minutes before
   retrying its cached negative preflight (browser-dependent;
   documented in the PR 4 README).

5. **Wildcard rejected.** `MCP_ALLOWED_ORIGINS='*'` is refused at
   startup (§6.1). Rationale: wildcard + bearer + loopback is the
   exact target shape of DNS-rebinding attacks against local
   services; and the v1 use case ("trusted team/network") needs a
   finite list of origins, not `*`. See §7.6.

### 6.5 Graceful shutdown

The existing SIGINT handler at `src/KnowledgeBaseServer.ts:27-30` is
extended to cover SIGTERM and to run a drain loop. The shape:

- A single `shuttingDown: boolean` flag; the signal handler is
  single-shot (second signal is a no-op, matches Unix convention; users
  needing force-kill send SIGKILL, which this process cannot intercept).
- On signal: log at `info`, then call `stopAccepting()` (which calls
  `server.close()` on the `node:http` listener — stops new connections
  from being accepted; leaves existing ones open).
- Then poll-wait: `while (inFlight > 0 && Date.now() < deadline)` with a
  50 ms sleep, where `deadline = now + MCP_SHUTDOWN_DEADLINE_MS`.
- After the drain (either `inFlight == 0` or deadline expired),
  **snapshot** `const live = [...sessions.values()]` into an array and
  iterate `live.forEach(t => t.close())`. Snapshotting guards against
  concurrent mutation of the `Map` via `onclose` callbacks (which can
  delete entries mid-iteration); the snapshot is a read-once list of
  transport handles. For `sse` mode this closes SSE holders; for `http`
  mode the same iteration closes each `StreamableHTTPServerTransport`.
- `await this.mcp.close()` then `process.exit(0)`.

**Race closure.** The `shuttingDown` check at §6.2.1 step 6 runs
*before* the `inFlight` increment in step 7. Once the flag flips, every
new dispatch returns `503` without touching the counter — `inFlight`
becomes monotonically non-increasing, so the drain loop cannot miss a
late-arriving keep-alive request sneaking into dispatch.

**`inFlight` definition.**

- Counted: dispatches of `POST /messages` (SSE) and non-`DELETE`
  `handleRequest` calls (streamable-HTTP).
- **Not counted:** `OPTIONS` preflight, `GET /ready`, SSE `GET /sse`
  stream open, rejected requests (host/origin/auth/session-miss/pre-auth
  503).

This distinction keeps the drain loop from being held hostage by a
long-lived SSE stream that is not actively dispatching — the stream's
open connection is handled by the post-drain `transport.close()` sweep.

**Deadline default 10 s.** Embedding calls to remote providers can
exceed 10 s in worst cases. The deadline trades "respect operator
shutdown signal" against "never drop a response"; operators who need
longer can raise `MCP_SHUTDOWN_DEADLINE_MS`. Under stdio the deadline
is immaterial (closing stdin unblocks the read loop instantly).

**Idempotency note.** The `shuttingDown` flag enforces single-shot at
the wrapper level; this is the primary guarantee. The SDK's transport
`close()` methods are resilient to double-invocation at the transport
level (SSE and streamable-HTTP both guard their internal response /
map state), but they invoke `onclose?.()` on every call — so the
wrapper's `onclose` handler will fire once per `close()` call plus
once per socket-level close event. The `sessions.delete(id)` inside
that handler tolerates double-fire (Map.delete of an absent key is a
no-op). Do not rely on SDK-level idempotency as a contract; rely on
the wrapper flag + idempotent Map.delete.

### 6.6 Logging — stderr JSON lines

Access log for HTTP transports goes through the existing `logger`
(`src/logger.ts:69-74`), which writes to `process.stderr` (and
optionally `LOG_FILE`) per the invariant at `src/logger.ts:16`. **No
new sink; no new destination; no stdout writes.** The stdio invariant
is moot under HTTP, but honoring it keeps one mental model across
transports.

**Format.** One JSON object per line, logged via `logger.info(...)`.
The existing `write()` path at `src/logger.ts:51-67` prepends an ISO
timestamp and level; the payload is a single JSON string preserving
that envelope:

```
2026-04-24T14:32:08.412Z [INFO] {"event":"http_access","req_id":"…","method":"POST","path":"/mcp","status":200,"duration_ms":47,"auth":"ok","origin":"https://console.team.example.com","host":"knowledge.example.com","bytes_out":812,"session":"…"}
```

**Fields.**

- `event` — always `http_access`. Distinct label for grep.
- `req_id` — a UUID generated at request start.
- `method`, `path` — from `req.method`, `req.url` (path only;
  query-string is **dropped** to defend against accidental token
  leakage via `?token=` typos).
- `status` — final response code.
- `duration_ms` — `performance.now()` delta.
- `auth` — `ok` | `missing` | `mismatch` | `malformed`. **Never the
  token value or a hash of it.**
- `origin` — the request's `Origin` header, or `null`.
- `host` — the request's `Host` header, or `null`.
- `session` — the (validated) session id for SSE POST and
  streamable-HTTP non-initialize requests; `null` otherwise.
- `bytes_out` — response body size. For SSE streams the field is
  emitted at stream close with the cumulative count (flagged in §8.2
  U2).

**Log level.** `http_access` is `info`. Startup bind is `info`. Shutdown
drain is `info`. CORS denials, auth failures, and shutdown-503s are
`info` with a non-2xx/3xx status (easy to grep). Unexpected errors
during dispatch are `error` — see the sanitization contract below.

**Log-injection defence.** All user-controllable fields
(`origin`, `host`, `session`, `method`, `path`) are serialized via
`JSON.stringify` on the payload object before being passed to
`logger.info`. `JSON.stringify` escapes `\n`, `\r`, and control
characters inside string values, so an adversarial header
(`Origin: evil\n[INFO] forged line`) cannot break out of the JSON
envelope and inject a spoofed log line. The emitter never interpolates
header values into a format string.

**Error-path sanitization contract.** `error`-level log lines for
unexpected dispatch failures must:

1. **Never log `req.headers` in full.** The bearer-token leak audit
   test (PR 2a 2a.5) must pass for the error path as well as the
   happy path: fire a dispatch error with a request whose `Authorization`
   carries a known token, assert the token does not appear in any log
   line.
2. **Never log the raw request body.** Error messages that include a
   body fragment (e.g., a JSON parse error whose `message` contains a
   span of the offending input) must be redacted: the error is
   wrapped as `new Error('dispatch failed: ' + err.name)` before being
   passed to `logger.error`. The original error's stack is logged
   separately as a structured field, and the stack's `message` line is
   rewritten to the same redacted form.
3. **Operator-forwarding contract.** The PR 4 README section "Running
   over HTTP" documents which fields are safe to forward to an external
   log aggregator (Loki, Datadog): `http_access` lines and `info`/`warn`
   lines are forwardable as-is; `error` lines may include operator-
   trusted paths but have been scrubbed of credentials and body
   fragments per (1) and (2).

### 6.7 Port binding

Default: `MCP_BIND_ADDR=127.0.0.1`. Loopback only. A user who wants the
server reachable off-host sets `MCP_BIND_ADDR=0.0.0.0` or a specific
interface. Startup logs the bind address and port explicitly; no silent
interpretation.

Rationale: a misconfigured bearer token on a `0.0.0.0` bind is publicly
exploitable; the same token on `127.0.0.1` is bounded to processes on
the same host. Defaulting to the latter is the secure-by-default choice
even though some deployments will explicitly choose the former. When
`MCP_BIND_ADDR != '127.0.0.1'`, the server emits a single `warn` line
at startup confirming the bind is off-host — so an operator typo
(`MCP_BIND_ADDR=0.0.0.o`) surfaces in the logs immediately.

When `MCP_BIND_ADDR != '127.0.0.1'` **and** `MCP_ALLOWED_HOSTS` is
unset (default loopback list), the server additionally emits a `warn`
line: "Listening off-host with default `MCP_ALLOWED_HOSTS`; non-
loopback clients will be rejected by the DNS-rebinding check. Set
`MCP_ALLOWED_HOSTS` to the hostnames clients will use." Catches the
"I bound to 0.0.0.0 but nothing connects" footgun before the first
client hits a 421.

**`X-Forwarded-For` is not trusted.** The wrapper never parses it;
client IP is not logged in v1 (see §6.6 field list). A future RFC that
adds client-IP logging will gate the trust behind an explicit
`MCP_TRUST_PROXY` toggle.

### 6.8 Readiness probe

One endpoint, one audience.

**`GET /ready`** (unauthenticated, no origin check). Returns:

```json
{ "status": "ok" }
```

plus `200 OK`. That is it. This is the load-balancer / uptime-monitor
probe. It returns the same response in both pre-initialize (server
coming up but not yet serving) and post-initialize states, because a
load balancer needs a cheap "is this pod reachable" signal. If the
process is running, `/ready` answers.

**Why unauthenticated is safe.** The response is literally the string
`{"status":"ok"}`. No KB data, no tool surface, no operator-set paths,
no version, no uptime, no fingerprint of the process. Leaking this is
exactly what leaking IPv4 existence leaks — an attacker who can reach
the port already knows the server exists.

**What is NOT shipped in v1.** A richer `/health/detail` endpoint
(version, uptime, provider, `FAISS_INDEX_PATH` fingerprint) was
considered and deferred per §4 non-goals. Issue #48 does not ask for
it, and its security argument (every field is safe to return behind
auth) is cleaner in a separate RFC that can think carefully about the
disclosure surface (`uptime` as a fingerprint, `providers.configured`
as a rate-limit-abuse target, `index_path_hash` preimage resistance).
See §11 follow-ups.

`HEAD /ready` is answered identically (Node's `http` gives HEAD for
free when `Content-Length` is set ahead of `res.write`). Every other
verb on `/ready` returns `405 Method Not Allowed`.

### 6.9 Composition with existing constraints

This RFC does not relax any existing single-process invariant; it
re-asserts each and adds one operator-facing note.

**FAISS is single-process-per-`FAISS_INDEX_PATH`.** Issue #44 tracks
the documentation and lockfile plan. The HTTP transport does not relax
this constraint. Running two server processes against the same path
races on FAISS index save (see `FaissIndexManager.updateIndex`; the
save call was hoisted out of the per-file loop in commits `8b2858c`
and `820b9c4`, but two processes sharing a path still race on the
single save) and corrupt each other.

*Worked example for scale-out (explicit because the HTTP transport
invites the question):* a team that wants two replicas behind a load
balancer must give each replica its own `FAISS_INDEX_PATH`, for
example `/srv/kb-replica-a/.faiss` and `/srv/kb-replica-b/.faiss`. If
the replicas are expected to serve the same corpus, both must index
the same `KNOWLEDGE_BASES_ROOT_DIR` independently, doubling indexing
work. This is a property of the FAISS-on-disk design, not of this
RFC, but users reach for it first under HTTP. If RFC 007 §6.4's
per-KB LRU lands, the LRU bound (`KB_CACHE_MAX`) applies per replica
— it does not share across processes. The PR 4 README
("Running over HTTP") calls this out as a first-class paragraph
pointing to RFC 007 §6.4.2 and issue #44.

**Tool surface is transport-agnostic.** `McpServer` exposes the tools
registered in `KnowledgeBaseServer.setupTools()`
(`src/KnowledgeBaseServer.ts:33-50`) over any `Transport`
implementation. Future tool additions from RFC 006 (`reload_config`,
see RFC 006 §5.4) and RFC 007 (`refresh_knowledge_base`, see RFC 007
§6.3) compose trivially — the transport layer in this RFC never
inspects the tool list.

**Tool argument schemas are transport-agnostic.** RFC 006 expands the
`retrieve_knowledge` Zod schema with `tier`, `top_k`, `max_distance`,
`min_rrf_score` (RFC 006 §5.4). These arrive over the same
`tools/call` JSON-RPC wire format regardless of transport; the
streamable-HTTP body and the SSE message frame carry bytes
identically.

**Stderr-only logging invariant (`src/logger.ts:16`) is preserved.**
§6.6 covers this explicitly.

**Per-query `updateIndex()` scan at `src/KnowledgeBaseServer.ts:84` is
untouched by this RFC.** RFC 007 §6.3 proposes removing that scan; the
two RFCs compose cleanly because the HTTP transport sits above the
tool handler. When RFC 007's PR lands, the HTTP transport inherits the
improvement without any code change in this RFC's surface.

**Embedding-provider selection is untouched.** `EMBEDDING_PROVIDER`
(`src/config.ts:12`) and related env vars (`src/config.ts:12-41`) keep
their current semantics; RFC 006's `EMBEDDING_PROVIDERS` addition also
composes cleanly — the transport layer never sees provider names.

## 7. Alternatives considered

### 7.1 Stdio-only forever

**Rejected.** It is the current state; §2 enumerates what it blocks.

### 7.2 Proxy daemon in front of stdio

Run a separate process that listens on HTTP, forks/spawns the stdio
server on demand, and pipes the two streams. **Rejected.** Doubles
the operational surface (two processes to supervise), doubles the
authn surface (the proxy needs its own secret), and re-creates the
single-process-per-`FAISS_INDEX_PATH` problem at the proxy layer (the
proxy must serialise spawns or corrupt the index). The transports
already exist in the SDK; integration is cheaper than a second
component.

### 7.3 Separate gateway binary inside this repo

Ship an `index-http.js` that imports the existing server and wraps
it. More code, more CI surface, no benefit over keeping the transport
switch inside the existing entry point. **Considered and deferred.**

### 7.4 WebSocket transport

**Deferred.** At time of writing, WebSocket is not in the MCP
transport spec. Implementing it on top of
`@modelcontextprotocol/sdk` would require implementing the
`Transport` interface manually — non-trivial, small benefit over
streamable-http's SSE-over-HTTP streaming. Revisit if the spec adopts
it.

### 7.5 Roll our own HTTP transport instead of using the SDK's

**Rejected.** The SDK ships the SSE and streamable-http classes.
Rolling our own re-implements session handling, SSE event framing,
and the MCP handshake — bugs the SDK has already found and fixed.

### 7.6 Bearer token in URL query-string as a fallback

Some browser-embedding flows cannot easily set headers on
`EventSource`. **Rejected for v1.** Tokens in query strings land in
server access logs, `Referer` headers, and reverse-proxy audit logs
in unpredictable places. §6.6 explicitly drops the query string from
the access log to defend against a user accidentally putting the
token there; accepting it would invert that defence. Documented in
§8 as an open issue; the mitigation (if it turns out browser
EventSource clients need it) is "support a short-lived cookie minted
from a bearer-auth POST to `/auth/session`" — a separate RFC.

### 7.7 Stateless streamable-HTTP mode in v1

**Deferred.** The SDK supports two modes (stateful per-session,
stateless per-request). Stateless has a separate lifecycle — per-request
transport construction and tear-down, different test matrix, different
shutdown semantics (no long-lived sessions to close). Bundling it in v1
would widen the PR 2c/3 scope and double the structural-target grid in
§10.1 for a knob no user has yet requested. A follow-up RFC can add
`MCP_HTTP_STATELESS=true` once there is a concrete use case (e.g.,
serverless workers).

### 7.8 `MCP_ALLOWED_ORIGINS='*'` support

**Rejected in v1** (see §6.1 validation and §6.4 point 5).
Wildcard + bearer + loopback default is the exact target of
DNS-rebinding attacks; wildcard without auth is out of scope (no
public-KB mode). Operators who want "any origin" means "no auth",
which is a separate RFC.

## 8. Risks, unknowns, open questions

### 8.1 Security-adjacent risks

- **R1 — Bearer token leakage in logs.** The contract in §6.6 forbids
  it for both happy and error paths; the test in §11 PR 2a (2a.5) and
  PR 2b (2b.4) pins both. The residual risk is a future refactor
  re-introducing `req.headers` dumping — the test guards against that.
- **R2 — DoS on the embedding provider via HTTP queries.** An attacker
  with a valid token can issue arbitrary `retrieve_knowledge` calls,
  each triggering one embedding round-trip. The provider's own rate
  limit is the backstop today. v1 does not add a per-server rate
  limit. Flagged in §4 non-goals; a mitigation (per-token rate
  counter) is a v2 candidate.
- **R3 — Shared bearer token rotation.** v1 reads `MCP_AUTH_TOKEN`
  once at startup. Rotating the token requires a restart. The PR 4
  README (§11) documents the operator runbook: "generate a new token
  with `openssl rand -base64 32`; update the deployment env; restart
  the server; update all clients. There is no revocation API in v1."
  A follow-up can support multiple valid tokens (trust-list file) for
  zero-downtime rotation.
- **R4 — Session-map flood.** An authed caller opening many SSE
  connections or initializing many streamable-HTTP sessions exhausts
  memory and file descriptors. `MCP_MAX_SESSIONS` (§6.1, default
  1000) caps the map size; requests beyond the cap return `503 Service
  Unavailable`. Tests in §11 PR 2b confirm the cap.
  *Why this is in v1 while R2 is deferred:* R2 (embedding-provider DoS)
  has an upstream backstop — the provider's own rate limiter rejects
  abusive query volume. R4 has **no** backstop; without a cap, a
  single buggy or malicious authed caller exhausts the wrapper's own
  resources and takes the server down for every other client. The cap
  is the in-process analogue of the rate limit the provider gives us
  for free.
- **R5 — Query-string credentials.** §7.6. Open until a concrete
  browser client need surfaces.
- **R6 — Auth-probe throttling.** Not in v1. A 32-byte random token
  is brute-force-infeasible at the request rates this process
  services (Node event-loop bounded at ~10³–10⁴ req/s); operators
  worried about log-flood DoS from 401 probes should front with
  fail2ban or equivalent. Documented in the PR 4 README.
- **R7 — Pickleparser trust boundary (issue #43) is unchanged.** The
  HTTP transport does **not** widen this boundary: the tool surface
  exposed over HTTP is still `list_knowledge_bases` and
  `retrieve_knowledge`, neither of which writes to
  `$FAISS_INDEX_PATH`. Writers are still local-filesystem-only.
  Issue #43 remains the tracking issue for the underlying risk;
  closing this bullet here so a future reviewer does not re-derive it.

### 8.2 Operational unknowns

- **U1 — TLS termination.** The server binds plain HTTP. v1 assumes a
  reverse proxy handles TLS on any non-loopback exposure. If
  deployers turn out to want in-process TLS, a follow-up can add
  `MCP_TLS_CERT_PATH` / `MCP_TLS_KEY_PATH`. Not in v1. Operators
  behind a proxy must set `MCP_ALLOWED_HOSTS` to match the hostname
  the proxy presents (§6.1) — the default list is loopback-only and
  will reject proxied requests otherwise.
- **U2 — SSE streams and byte accounting.** The `bytes_out` field in
  §6.6 is exact for request/response pairs. For long-lived SSE
  streams it is emitted at stream close with the cumulative count
  — a stream that stays open all day gets one end-of-day log line
  rather than continuous updates. Acceptable for v1.
- **U3 — Stateful session memory.** `MCP_MAX_SESSIONS` caps the map
  size (R4). Individual session memory is bounded by whatever
  `StreamableHTTPServerTransport` allocates for message history and
  stream maps (`streamableHttp.d.ts:107`: "State is maintained
  in-memory"). The cap is a coarse memory bound.
- **U4 — Startup-order behavior under HTTP.** §6.2 moves
  `initialize()` ahead of the HTTP bind to close a client-races-
  init window. Stdio's order is unchanged (G2); clients parsing the
  startup log are unaffected.
- **U5 — Stream-shutdown interaction.** `server.close()` stops new
  connections while keeping existing ones open. §6.5's post-drain
  `transport.close()` sweep proactively closes live SSE streams;
  clients reconnect per the SSE protocol.

### 8.3 Open items for the maintainer to resolve

- **O1 — SIGHUP for config reload.** Not in draft. If operators want
  to rotate `MCP_AUTH_TOKEN` without restart, SIGHUP is the Unix idiom.
  Adding later is additive.
- **O2 — `MCP_MAX_SESSIONS=1000` default.** Draft picks 1000. Looser
  (10 000) or stricter (100) both defensible. Memory per session is
  dominated by the SDK's message-history retention; a calibration
  measurement in the PR 3 integration test would settle this. Default
  Linux `ulimit -n` is 1024, so values > ~500 warrant an FD-limit
  check in the PR 4 README.
- **O3 — SSE `transport.close()` on shutdown sweep.** Draft specifies
  it for both modes. If the maintainer prefers "abandon; let the OS
  reap", that is one line simpler but leaves SSE clients hanging
  for `socket.timeout` rather than reconnecting cleanly.

## 9. Rollout plan

Staged, one PR per stage. PRs aim at ≤ 500 lines diff where feasible;
reviewability (one concern per PR) is the harder constraint. All stages
preserve stdio as the default.

| Stage | PR | Risk | Depends on | Gate |
| ----- | -- | ---- | ---------- | ---- |
| 1 | **RFC approval** — this doc lands, no code | low | — | RFC approved. |
| 2a | Env/config validation + `HttpTransportHost` skeleton + `/ready` + bearer auth + CORS + stderr JSON access log | med | 1 | `/ready` answers; auth rejects missing/wrong tokens; CORS preflight works; leak test green. Likely 500–800 lines including tests; if that exceeds what fits a single reviewable PR, split into 2a-config (env + validation + `run()` dispatch stub) and 2a-http (auth.ts + HttpTransportHost + `/ready` + leak test). |
| 2b | SSE transport dispatch on top of 2a | med | 2a | SSE round-trip integration test; session cap enforced; session-map leak test (non-DELETE disconnect cleans up). |
| 2c | Graceful shutdown handler replacing the SIGINT block | med | 2a | SIGTERM and SIGINT both drain; `shuttingDown` gate race-tested; snapshot-before-close-sweep pattern tested under concurrent disconnects. |
| 3 | Streamable HTTP transport (stateful mode only, per §6.2.3) | med | 2c | Stateful round-trip integration test with session id over `Mcp-Session-Id`; session-map leak test (non-DELETE disconnect cleans up); "no valid session id" 400 branch tested. |
| 4 | CI loopback HTTP round-trip integration test + docs | low | 3 | CI lane added under `.github/workflows/`; `README.md` section added. |

**Implementation-only PRs; the RFC merges in stage 1.** This RFC is
document-only. Implementation tasks pick up from stage 2a onward after
approval.

**Backward compatibility.** Every stage is additive under the `stdio`
default. Users who never set `MCP_TRANSPORT` cannot observe any of this
work.

## 10. Success metrics

Metrics are **structural** where possible (does the code do the thing?)
and **wall-time** only for the narrow loopback round-trip latency claim.
No recall-style quality numbers — this RFC is transport, not retrieval.

### 10.1 Structural targets (gated in CI)

| Metric | Target | Stage |
| ------ | ------ | ----- |
| Startup with `MCP_TRANSPORT=sse` and `MCP_AUTH_TOKEN` unset | Process exits non-zero; stderr contains "requires MCP_AUTH_TOKEN" | 2a |
| Startup with `MCP_TRANSPORT=sse` and `MCP_AUTH_TOKEN.length < 32` | Process exits non-zero; stderr contains "at least 32 characters" | 2a |
| Startup with `MCP_ALLOWED_ORIGINS='*'` | Process exits non-zero; stderr points to §7.6 | 2a |
| Startup with `MCP_TRANSPORT=sse` and valid config | Listener bound on `127.0.0.1:8765`; startup log line includes transport + bind + redacted token fingerprint | 2a |
| Startup with `MCP_TRANSPORT=stdio` and HTTP-only vars set | Starts successfully; single `warn` line listing ignored vars | 2a |
| Request without `Authorization` header | `401` with `WWW-Authenticate: Bearer`; `auth=missing` in log; token value absent from all log output | 2a |
| Request with wrong bearer token | `401`; `auth=mismatch`; token absent from log | 2a |
| `verifyBearer` handles non-UTF-8 bytes without substitution | Unit test: `Bearer \xff\xff...` does not match token containing the `U+FFFD` replacement sequence | 2a |
| Preflight `OPTIONS` from listed origin | `204` with matching `Access-Control-Allow-Origin` | 2a |
| Preflight `OPTIONS` from unlisted origin | `403` with no `Access-Control-*` headers | 2a |
| Non-`OPTIONS` request with missing `Origin` | `403` (wrapper layer); `auth=missing` style log | 2a |
| `GET /ready` without auth | `200` with `{"status":"ok"}` | 2a |
| `HEAD /ready` without auth | `200` with same headers as GET, empty body | 2a |
| Any verb other than GET/HEAD on `/ready` | `405 Method Not Allowed` | 2a |
| Access-log JSON-escapes adversarial headers | `Origin: "\n[INFO] fake"` produces one log line whose JSON payload escapes the newline | 2a |
| Error path does not leak token | Dispatch throws with a known token in the stack; log output scrubbed | 2a + 2b |
| SSE round-trip: open `/sse`, receive session id, `POST /messages?sessionId=<id>` with `tools/list` | Lists the two tools; same session id in the access log | 2b |
| SSE session cap (`MCP_MAX_SESSIONS=2`) | Third concurrent SSE open returns `503` | 2b |
| SSE new connection during shutdown | `GET /sse` after SIGTERM returns `503` with `Retry-After: 0` | 2b + 2c |
| SSE session-map cleanup on client disconnect | Client drops mid-stream (no DELETE); `sessions` map entry removed via `onclose` | 2b |
| Invalid SSE `sessionId` format on `POST /messages` | `400` with `session=malformed` | 2b |
| SIGTERM on an idle HTTP server | Exits within 1 s with code `0`; no "forcing close" warning | 2c |
| SIGTERM with one in-flight POST request | Waits up to `MCP_SHUTDOWN_DEADLINE_MS` for the response; exits `0` | 2c |
| SIGTERM during active SSE stream | Drain loop ignores the SSE-GET connection; `transport.close()` sweep after drain closes the stream; exit within 1 s | 2c |
| Shutdown race: new dispatch after `shuttingDown` flip | `503` with `Retry-After: 0`; `inFlight` never incremented | 2c |
| Streamable HTTP stateful session | Two consecutive `tools/call` on the same `Mcp-Session-Id` succeed | 3 |
| Streamable HTTP second-client initialize | A second `initialize` (no `Mcp-Session-Id`) mints a new session; both sessions live concurrently | 3 |
| Streamable HTTP absent-session-id + non-initialize | `POST /mcp` with body `{"method":"tools/call",…}` and no `Mcp-Session-Id` → `400` "No valid session id; non-initialize method requires Mcp-Session-Id" | 3 |
| Streamable HTTP session-map cleanup on non-DELETE disconnect | Client TCP-drops mid-stream; `onclose` wiring removes the map entry (not relying on `onsessionclosed`) | 3 |
| `MCP_ALLOWED_HOSTS` accepts proxy hostname | Request with `Host: knowledge.example.com` matches when configured | 3 |

### 10.2 Wall-time target (one number, warn-only)

- **T1** — A no-op MCP `tools/list` round-trip over `MCP_TRANSPORT=http`
  on `127.0.0.1` against a warm server takes p95 ≤ 10 ms on a
  developer laptop. **Measurement shape** (for reproducibility):
  warm-up 10 iterations discarded, measure 100 iterations, report p95.
  The target tracks a no-op to isolate transport overhead from
  application work; `list_knowledge_bases` was considered and
  rejected because RFC 007 §6.4 may change its internals. The CI
  job (PR 4) records the p95 as an artifact and **warns — does not
  fail** — on a > 50% regression.

### 10.3 Non-numeric success signals (merge gates unless noted)

- `README.md` gains a "Running over HTTP" section in PR 4 with: env
  var list; `openssl rand -base64 32` token-generation example;
  Claude Desktop / Codex / Cursor / Cline config snippets pointing at
  an HTTP endpoint; loopback-default warning; one-process-per-
  `FAISS_INDEX_PATH` warning (ties to issue #44 and RFC 007 §6.4.2);
  token-rotation runbook (R3); non-browser clients must send `Origin`
  (§6.4); auth-probe throttling guidance (R6). *(Merge gate.)*
- `CHANGELOG.md` entry per PR under `[Unreleased] Added`. *(Merge
  gate.)*
- **Post-release signal (non-gate):** 30 days after PR 4 lands, no
  issue reports "my token leaked into a log file" or "the server
  accepted a request with a wrong token". If either arrives, revert
  and rethink; if neither, the transport is operationally sound.

## 11. Implementation checklist

Stages and dependencies mirror §9. The RFC itself is PR 1; the numbered
PRs below describe the implementation work that follows approval.

### PR 1 — RFC (this document)

- [ ] **1.1** `docs/rfcs/008-remote-transport.md` lands. No code
      changes.
- [ ] **1.2** PR description references issue #48 with `References:
      #48` (not `Closes:`, which applies when PR 4 lands).

### PR 2a — Config + auth + `/ready` + CORS + access log

- [ ] **2a.1** Add `MCP_TRANSPORT`, `MCP_PORT`, `MCP_BIND_ADDR`,
      `MCP_AUTH_TOKEN`, `MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_HOSTS`,
      `MCP_SHUTDOWN_DEADLINE_MS`, `MCP_MAX_SESSIONS` to
      `src/config.ts`. Origin normalization per RFC 6454 (§6.4 point
      3). No stateless / short-token / wildcard escape hatches.
- [ ] **2a.2** Tests: each row of §6.1 validation contract is a
      dedicated test case.
- [ ] **2a.3** `src/transport/auth.ts` with `verifyBearer` per §6.3.
      Tests cover equal-length and mismatched tokens, missing/malformed
      headers, `latin1` byte-preservation (U+FFFD case), and the
      `try/catch` belt-and-braces path.
- [ ] **2a.4** `src/transport/HttpTransportHost.ts` skeleton serving
      only `/ready` + `OPTIONS` preflight + auth + CORS + Host/Origin
      checks + request-id + `http_access` JSON log emitter per §6.6.
      No SSE, no streamable-HTTP yet.
- [ ] **2a.5** Bearer-token leak test: dispatch a request with a
      known token through the full handler stack (including an
      injected dispatch error); assert the token substring does not
      appear in any log line or `logger.*` call.
- [ ] **2a.6** Modify `src/KnowledgeBaseServer.ts` `run()` to
      dispatch to `runStdio()` (the original body) or
      `HttpTransportHost` based on `config.MCP_TRANSPORT`.
      `initialize()` ordering change applies only on the HTTP branch
      per §6.2; stdio branch is byte-identical.
- [ ] **2a.7** `CHANGELOG.md` entry under `[Unreleased] Added` naming
      the new env vars and the `/ready` endpoint.

### PR 2b — SSE transport dispatch

- [ ] **2b.1** SSE `GET /sse` + `POST /messages` flow per §6.2.2.
      Session map with `onclose` cleanup registered before `await
      connect()` and map-insert-before-`await` to close the
      insert/close race.
- [ ] **2b.2** `MCP_MAX_SESSIONS` enforcement: test `503` at cap+1.
      Also test the shutdown-gate for `GET /sse` (new stream during
      shutdown → `503`).
- [ ] **2b.3** Session-id format validator (UUID-shape regex — loose
      in the version nibble) on `POST /messages?sessionId=…`; `400` on
      malformed; `404` on unknown.
- [ ] **2b.4** Bearer-leak test extended to SSE POST path including
      an injected dispatch error.
- [ ] **2b.5** Session-map cleanup test: open SSE, close the client
      socket without DELETE, assert the `sessions` map is empty (via
      a follow-up request or a test-only hook).
- [ ] **2b.6** Integration test: spawn `build/index.js` with
      `MCP_TRANSPORT=sse` + temp token + temp KB; open SSE, issue
      `tools/list`, confirm the two tools appear.
- [ ] **2b.7** `CHANGELOG.md` update naming SSE transport.

### PR 2c — Graceful shutdown

- [ ] **2c.1** Replace the SIGINT handler at
      `src/KnowledgeBaseServer.ts:27-30` with the extended graceful
      handler per §6.5. Handle both `SIGINT` and `SIGTERM`.
- [ ] **2c.2** `inFlight` counter wired per §6.2.1 step 7 and the
      `finally` block in §6.2.1 step 9. `shuttingDown` gate at step
      6 so new dispatches return `503` before incrementing.
- [ ] **2c.3** Race test: fire `shuttingDown` flag while a keep-alive
      request is parsing; assert the request gets `503` and
      `inFlight` was not incremented.
- [ ] **2c.4** SSE shutdown: open an SSE stream, send SIGTERM; assert
      the drain loop completes quickly (SSE GET is not counted as
      in-flight) and `transport.close()` closes the stream.
- [ ] **2c.5** Stdio shutdown behavior unchanged (same drain loop
      runs but with nothing to drain; exits same wall-time as today).

### PR 3 — Streamable HTTP transport (stateful only)

- [ ] **3.1** Extend `HttpTransportHost` to recognise
      `MCP_TRANSPORT === 'http'` and route via a per-session
      `StreamableHTTPServerTransport` map per §6.2.3.
      `onsessioninitialized` inserts into the map; `onclose`
      (registered separately on every new transport) deletes the
      entry on every non-DELETE close path.
- [ ] **3.2** `Mcp-Session-Id` header extraction with the same
      UUID-shape regex as §6.2.2 step 1 (log-injection defence);
      branch matrix per §6.2.3 step 2 (absent+initialize → mint,
      absent+non-initialize → `400`, present+initialize → `404` with
      diagnostic hint, present+non-initialize → route).
- [ ] **3.3** `MCP_ALLOWED_HOSTS` test covering proxied-hostname
      acceptance and default loopback-only behavior.
- [ ] **3.4** Integration test variant: stateful happy path — two
      consecutive `tools/call` on the same session succeed; a second
      `initialize` (no `Mcp-Session-Id`) mints a fresh session and
      both sessions live concurrently.
- [ ] **3.5** Integration test: `DELETE /mcp` session termination
      drops the map entry (via `_onsessionclosed` which the SDK fires
      on DELETE, and also via `onclose` which fires for all close
      paths — both paths must be test-covered).
- [ ] **3.6** Integration test: client TCP-drops mid-stream (no
      DELETE); map entry is removed via `onclose`, not
      `_onsessionclosed`.
- [ ] **3.7** `CHANGELOG.md` update naming streamable-http.

### PR 4 — CI loopback round-trip + docs

- [ ] **4.1** Add a CI job under `.github/workflows/` that builds
      the server, launches it with `MCP_TRANSPORT=http`, runs a
      small MCP client script (`@modelcontextprotocol/sdk` `Client` +
      `StreamableHTTPClientTransport`), hits `tools/list`,
      `list_knowledge_bases`, and `retrieve_knowledge` against a
      seeded temp KB, and measures the T1 round-trip p95 per §10.2.
- [ ] **4.2** The CI job uploads the latency JSON as an artifact;
      warns but does not fail on regression (same pattern as RFC 007's
      bench job).
- [ ] **4.3** `README.md` "Running over HTTP" section: env var list;
      `openssl rand -base64 32` token example (with guidance to
      **generate**, not type — entropy note); client config snippets
      (Claude Desktop, Codex, Cursor, Cline, curl); loopback warning;
      one-process-per-`FAISS_INDEX_PATH` warning with worked-example
      paragraph (§6.9); non-browser clients must send `Origin`
      header; token-rotation runbook (R3); auth-probe-throttling
      guidance (R6); `X-Forwarded-For` non-trust note; FD-limit
      guidance when raising `MCP_MAX_SESSIONS` above ~500 (§8.3 O2);
      `MCP_ALLOWED_HOSTS` entries are lowercased (§6.4 point 3a).
- [ ] **4.4** `CHANGELOG.md` entry: "Running over HTTP" docs and CI
      lane.

### Follow-ups (tracked as issues, not gated by this RFC)

- Extend `smithery.yaml` with a non-stdio deployment block: the RFC
  introduces `MCP_TRANSPORT`, `MCP_PORT`, `MCP_AUTH_TOKEN`,
  `MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_HOSTS`, `MCP_MAX_SESSIONS`,
  `MCP_SHUTDOWN_DEADLINE_MS` — the Smithery schema needs each
  enumerated so hosted deploys can configure them. The tracking issue
  can share scope with the existing `embeddingProvider` enum gap
  (issue #34).
- Update `CLAUDE.md`'s "Transport" description when §6.9 composition
  details stabilize post-PR 4.
- Extend the "Verification beyond `npm test`" recipe in `CLAUDE.md`
  with an HTTP-client spawn variant alongside the existing stdio one.
- Add a `docs/deployment/http-exposure.md` page walking through
  TLS-proxy setup, systemd unit, and firewall rules for operators who
  set `MCP_BIND_ADDR=0.0.0.0`.
- `/health/detail` (or equivalent) behind auth — version, uptime,
  provider, `FAISS_INDEX_PATH` fingerprint. Deferred from v1 per §4
  non-goals and §6.8.
- Per-token trust list for zero-downtime rotation (R3).
- Per-token rate limiter for embedding-provider protection (R2).
- SSE-stream byte-accounting fidelity (U2).
- Stateless streamable-HTTP mode (§7.7) if a concrete use case
  emerges.
- SIGHUP config reload (O1).

---

*End of RFC 008.*
