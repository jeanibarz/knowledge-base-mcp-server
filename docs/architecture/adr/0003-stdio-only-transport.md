# 0003 — stdio-only MCP transport (for now)

- **Status:** Superseded by RFC 008 implementation; stdio remains the default
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

MCP supports multiple transports: stdio (pipe-based, one client per process), SSE (HTTP streaming), and WebSocket (per the `@modelcontextprotocol/sdk`). The server needs to pick one or more to support out of the box.

## Decision Drivers

- **Target audience.** Primary users launch the server as a subprocess of an MCP client — Claude Desktop, Codex CLI, Cursor, Continue, Cline. All of these launch over stdio by default.
- **Authentication surface.** stdio inherits the launching user's permissions; remote transport requires designing an auth story (bearer token, mTLS, something).
- **Deployment complexity.** stdio servers are single-binary; remote requires port selection, TLS config, reverse-proxy guidance.
- **Review cost.** Adding remote transport is a meaningful security surface (see RFC 008 draft).

## Considered Options

1. **stdio only**, gate remote on a future RFC.
2. **stdio + SSE** from day one, behind an env flag.
3. **stdio + WebSocket** (less mature in the MCP SDK as of the referenced commit).
4. **Remote-only** (network-attached server).

## Decision Outcome

**Original outcome: option 1 — stdio only.** That was the correct initial
shipping posture.

**Current outcome:** stdio remains the default, and RFC 008 has since added
opt-in SSE and streamable HTTP transports. Remote modes require
`MCP_AUTH_TOKEN`, reject wildcard browser origins, bind to loopback by default,
and share the same MCP tool registration path.

## Pros and Cons

**Pros:**
- Zero auth story required. The client that spawned the process is the user; stderr/stdin/stdout are the only channels.
- Matches the default behaviour of every current MCP client, so "install" is `add this JSON to your config and restart".
- Small attack surface — no open ports, no listener thread.

**Cons:**
- Stdio still has one-client-per-process semantics.
- HTTP/SSE modes add a network listener and therefore require the auth/origin
  posture described in the threat model.
- TLS termination and general internet-facing rate limiting remain out of scope
  for this server.

## More Information

- RFC 008 is now implemented in `src/transport-config.ts`,
  `src/transport/sse.ts`, `src/transport/http.ts`, and
  `src/transport/base-http-host.ts`.
