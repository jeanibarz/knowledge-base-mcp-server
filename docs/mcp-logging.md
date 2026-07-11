# MCP Logging Capability

The server advertises the standard MCP `logging` capability. Clients can send
`logging/setLevel` to choose the minimum severity of subsequent MCP logging
notifications without changing the process's file/stderr log configuration.

## Transport behavior

| Transport | `logging/setLevel` behavior |
| --- | --- |
| Streamable HTTP | Stores the requested minimum level on the identified MCP session. |
| SSE | Stores the requested minimum level on the identified MCP session. |
| stdio | Accepts the request as a no-op. A stdio process has one root session, so the remote host's per-session filter does not apply. |

HTTP and SSE sessions that never call `logging/setLevel` receive every MCP log
level. Once a level is set, only messages at that severity or higher are sent
to that session. One session's preference does not affect other sessions, and a
notification failure for one client does not prevent delivery attempts to the
remaining clients.

This capability filters MCP logging notifications only. `KB_LOG_FORMAT` and
`LOG_FILE` continue to control the process's canonical/text operator logs; see
the [logging and incident runbooks](operations/logs-reader.md).

## Evidence

- Capability registration and request handling: `src/KnowledgeBaseServer.ts`
- Per-session level state and notification filtering:
  `src/transport/base-http-host.ts`
- HTTP and SSE behavior tests: `src/transport/http.test.ts` and
  `src/transport/sse.test.ts`
