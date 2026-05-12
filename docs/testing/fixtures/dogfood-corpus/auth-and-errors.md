---
fixture_owner: retrieval-eval
status: stable
topic: auth
---

# Authentication And Retrieval Errors

The server accepts `MCP_AUTH_TOKEN` as the bearer token used by MCP clients.
When an authenticated query reaches a knowledge base whose vector index has not
been created, the retrieval layer reports `INDEX_NOT_INITIALIZED`.

These exact tokens are intentionally present in this corpus so hybrid retrieval
can be checked against dense-only behavior for out-of-vocabulary identifiers.

