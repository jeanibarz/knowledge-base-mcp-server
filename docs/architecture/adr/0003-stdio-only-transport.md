# 0003 — stdio-only MCP transport (for now)

- **Status:** Accepted (provisional — see RFC 008 for the remote-transport design)
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

**Option 1 — stdio only.** Implemented at `src/KnowledgeBaseServer.ts:126-127` via `StdioServerTransport`. Remote transport is explicitly a follow-up; RFC 008 captures that design.

## Pros and Cons

**Pros:**
- Zero auth story required. The client that spawned the process is the user; stderr/stdin/stdout are the only channels.
- Matches the default behaviour of every current MCP client, so "install" is `add this JSON to your config and restart".
- Small attack surface — no open ports, no listener thread.

**Cons:**
- No multi-client support. One server = one client.
- No way to run the server on one host and query from another (the natural "shared team knowledge base" shape).
- Any future remote transport must be retrofitted through `McpServer.connect(...)` (`src/KnowledgeBaseServer.ts:127`) in a way that doesn't regress the stdio path.

## More Information

- RFC 008 is the design for remote transport; this ADR is **not** a rejection of remote, only a decision to defer.
- The SIGINT handler at `src/KnowledgeBaseServer.ts:27-30` assumes stdio lifecycle — it tears down the MCP server on receipt. Remote transport will likely keep the same handler with different implications for client reconnection; the future RFC covers that.
