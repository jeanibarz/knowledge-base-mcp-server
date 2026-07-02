# MCP Resources and `kb://` URIs

The server exposes MCP resources for clients that want to enumerate and read source documents directly. Resources are different from the `retrieve_knowledge` tool:

| Surface | Use it for | What it returns |
| --- | --- | --- |
| `retrieve_knowledge` | Dense semantic or hybrid dense+BM25 search over indexed chunks. | Ranked markdown snippets with source metadata. |
| `resources/list` | Discovering addressable files under the configured knowledge-base root. | One `kb://` URI per ingestable, non-quarantined file, with optional pagination. |
| `resources/read` | Reading a known source document by URI. | The raw file content as text or a base64 blob. |

Use resources when a client already knows which document it needs, or when it wants to let a user browse/read files. Use `retrieve_knowledge` when the client needs retrieval by meaning, keywords, filters, or ranking.

## Resource Listing

`resources/list` walks every non-hidden knowledge base under `KNOWLEDGE_BASES_ROOT_DIR` and returns files that match the same ingest eligibility policy used by refresh/search indexing. Dot-prefixed files and directories are skipped, including `.index`, `.faiss`, and user-created draft folders. Built-in ingest exclusions, `INGEST_EXTRA_EXTENSIONS`, `INGEST_EXCLUDE_PATHS`, and per-KB ingest quarantine entries are also honored, so clients do not browse files the index would currently skip.

The no-parameter request remains backward-compatible: it returns the full concrete resource list and no cursor. Clients browsing large roots can pass these optional params:

| Param | Meaning |
| --- | --- |
| `cursor` | Standard MCP pagination cursor returned as `nextCursor`; it is opaque and includes the original filters and page size. |
| `limit` or `pageSize` | Positive integer page size. Values above 1000 are capped to 1000. |
| `kbName` | Restrict listing to one knowledge base. `knowledgeBase` and `knowledge_base_name` are accepted aliases. |
| `prefix` | Restrict listing to KB-relative paths beginning with this prefix, such as `runbooks/` or `notes/2026-`. |

Paginated response shape:

```json
{
  "resources": [
    {
      "uri": "kb://work/runbooks/deploy.md",
      "name": "runbooks/deploy.md",
      "description": "Document in knowledge base \"work\"",
      "mimeType": "text/markdown"
    },
    {
      "uri": "kb://research/notes/contextual-retrieval.html",
      "name": "notes/contextual-retrieval.html",
      "description": "Document in knowledge base \"research\"",
      "mimeType": "text/html"
    }
  ],
  "nextCursor": "kbres1.eyJ2IjoxLCJvZmZzZXQiOjEwMDAsInByZWZpeCI6IiIsImxpbWl0IjoxMDAwfQ"
}
```

The server also handles `resources/templates/list`, returning a `kb://{kb}/{path}` URI template for clients that support templated discovery. Clients can use the template, concrete URIs returned by `resources/list`, or retrieval citations.

Clients that implement MCP `completion/complete` can ask the server for guided argument values for this template:

| Template argument | Completion values |
| --- | --- |
| `kb` | Knowledge-base directory names under `KNOWLEDGE_BASES_ROOT_DIR`, prefix-matched against the in-progress value. |
| `path` | Ingestable, non-quarantined KB-relative paths within the selected `kb`, prefix-matched against the in-progress value and capped to the MCP completion page size. |

## Resource List Change Notifications

The server emits MCP `notifications/resources/list_changed` whenever a successful mutation changes the concrete `resources/list` output:

- `add_document` emits after creating a new ingestable file, but not when overwriting an existing URI.
- `delete_document` emits after removing an ingestable file.
- `refresh_knowledge_base` emits only when the resource listing differs from the last snapshot.
- The optional filesystem watcher emits after a watched create or delete changes the resource listing.

The notification means clients should invalidate cached `resources/list` results and request the list again. It is intentionally coarser than per-resource update streaming: the server does not yet implement `resources/subscribe` or `notifications/resources/updated`.

In stdio mode the notification is sent on the root MCP server. In SSE and streamable HTTP modes it is fanned out to every live session; a failure in one session is logged at debug level and does not prevent delivery attempts to the remaining sessions.

## `kb://` URI Format

Resource URIs use this form:

```text
kb://<knowledge-base>/<encoded-relative-path>
```

Examples:

```text
kb://work/runbooks/deploy.md
kb://agent-task-lessons/reviews/pr%20%23123.md
kb://research/notes/attention%20%26%20retrieval.html
```

Rules:

- `<knowledge-base>` is the KB directory name, such as `work` or `research`.
- KB names must be lowercase filesystem-safe names: letters, digits, dot, underscore, and hyphen, starting with a letter or digit.
- The path is relative to that KB root.
- Each path segment is percent-encoded independently. Reserved filename characters such as space, `#`, `?`, `&`, `+`, and `=` are encoded.
- Literal or encoded path traversal is rejected. `..`, `%2f`, and `%5c` cannot be used to escape a KB root.
- URI fragments may appear in retrieval citations, for example `kb://work/runbooks/deploy.md#L42-L78`. `resources/read` reads the file; line fragments are for client navigation and citation display.

When constructing URIs manually, encode each path segment rather than the whole path so `/` remains the segment separator:

```js
const uri = `kb://${kbName}/${relativePath
  .split("/")
  .map((segment) => encodeURIComponent(segment))
  .join("/")}`;
```

## Reading Resources

`resources/read` accepts a `kb://` URI and returns one content item:

```json
{
  "contents": [
    {
      "uri": "kb://work/runbooks/deploy.md",
      "mimeType": "text/markdown",
      "text": "# Deploy Runbook\n\n..."
    }
  ]
}
```

Markdown resources can opt into a frontmatter read policy:

```yaml
---
kb_policy:
  resource_read: local_only # allow | local_only | deny
---
```

`deny` blocks `resources/read` for every transport. `local_only` allows the
default stdio/local server but blocks HTTP/SSE reads (`MCP_TRANSPORT=http` or
`sse`). This is a local authoring policy, not multi-user authorization.

PDF files are returned as base64 blobs when `.pdf` is opted into ingest with `INGEST_EXTRA_EXTENSIONS=.pdf`:

```json
{
  "contents": [
    {
      "uri": "kb://research/papers/contextual-retrieval.pdf",
      "mimeType": "application/pdf",
      "blob": "JVBERi0xLjQK..."
    }
  ]
}
```

MIME type mapping is intentionally small and extension-based:

| Extension | MIME type | Payload field |
| --- | --- | --- |
| `.md`, `.markdown` | `text/markdown` | `text` |
| `.html`, `.htm` | `text/html` | `text` |
| `.pdf` when allowed by ingest config | `application/pdf` | `blob` |
| `.txt` and other extensions | `text/plain` | `text` |

## Security and Client Behavior

Resources expose raw source documents under `KNOWLEDGE_BASES_ROOT_DIR`. They do not apply semantic retrieval thresholds, relevance gating, chunk packing, or search filters. Clients should treat returned document text as untrusted content when the KB contains material from outside the local user's trust boundary.

`resources/read` does apply `kb_policy.resource_read` from Markdown
frontmatter. `resources/list` may still reveal the existence and path of a
policy-protected document; use ingest exclusions for documents that should not
be discoverable as resources at all.

For normal agent retrieval, prefer `retrieve_knowledge`. For explicit document browsing, file previews, citation expansion, or "open this source" actions, use `resources/list` and `resources/read`.
