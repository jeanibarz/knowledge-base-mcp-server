# MCP Prompts and reusable KB templates

The server can expose MCP **prompts** — the third first-class MCP primitive
alongside tools (`retrieve_knowledge`, `ask_knowledge`, …) and resources
(`kb://` URIs). Prompts are small, server-shipped, parameterized templates that
a client (Claude Desktop, IDE plugins) can surface as slash-commands / a "/"
menu. Each one pre-wires a grounded `retrieve_knowledge` workflow so users get a
well-formed, citation-disciplined prompt with one click instead of writing it by
hand.

This surface is **opt-in** and **read-only**: answering `prompts/get` only
substitutes your arguments into instruction text and returns it. The server does
**not** run retrieval, call an LLM, or read files while serving a prompt — the
returned message tells the agent to call `retrieve_knowledge` itself.

## Enabling

Prompts are off by default. Set `KB_MCP_PROMPTS=on` in the server's environment
(the same env block where you set `KNOWLEDGE_BASES_ROOT_DIR`). Accepted truthy
values: `on`, `1`, `true`, `yes`. Restart the server after changing it.

```json
"env": {
  "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
  "EMBEDDING_PROVIDER": "ollama",
  "OLLAMA_MODEL": "dengcao/Qwen3-Embedding-0.6B:Q8_0",
  "KB_MCP_PROMPTS": "on"
}
```

When the flag is off, the server does not advertise the `prompts` capability and
`prompts/list` / `prompts/get` are not registered.

## Templates

`prompts/list` returns the fixed registry below. v1 is intentionally a small,
opinionated set — there is no user-defined-prompt store.

| Prompt | Purpose | Arguments |
| --- | --- | --- |
| `summarize_kb` | Summarize what a KB contains, grounded and cited. | `knowledge_base_name` (optional), `focus` (optional) |
| `cite_sources` | Answer a question strictly from the KB, citing each claim. | `question` (required), `knowledge_base_name` (optional) |
| `compare_notes` | Compare and contrast two topics with citations per side. | `topic_a` (required), `topic_b` (required), `knowledge_base_name` (optional) |
| `research_brief` | Produce a short, cited research brief on a topic. | `topic` (required), `knowledge_base_name` (optional), `k` (optional) |

When `knowledge_base_name` is omitted, the rendered prompt instructs the agent to
search all registered KBs (the `retrieve_knowledge` default); when provided, it
pins the retrieval to that single shelf. Every template instructs the agent to
ground its answer in the retrieved chunks, cite source paths, and abstain rather
than invent when the KB does not cover the request.

The server advertises MCP `completion/complete` so clients can request argument
suggestions. Prompt `knowledge_base_name` arguments complete from registered KB
names. Model-style prompt arguments are completed from registered `model_id`
values when a future prompt template declares one.

## Example: `prompts/get`

Request:

```json
{
  "method": "prompts/get",
  "params": {
    "name": "cite_sources",
    "arguments": {
      "question": "How does the relevance gate decide to abstain?",
      "knowledge_base_name": "notes"
    }
  }
}
```

Response (shape):

```json
{
  "description": "Answer a question strictly from retrieved knowledge-base chunks, citing the source path for every claim.",
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "Answer this question using only the knowledge base: \"How does the relevance gate decide to abstain?\"\n\n1. Call the retrieve_knowledge tool with query=\"How does the relevance gate decide to abstain?\" scoped to the \"notes\" knowledge base (pass knowledge_base_name=\"notes\").\n2. ..."
      }
    }
  ]
}
```

A missing required argument or an unknown prompt name returns a protocol error.

## Client support

Prompt rendering in the client UI varies. Claude Desktop surfaces server prompts
in its "/" menu; some IDE plugins do not yet render the prompts capability at
all. If your client does not show the templates, it either does not implement
`prompts/list` or needs `KB_MCP_PROMPTS=on` set on the server side. The CLI
(`kb`) does not use this surface.

## Safety note

Templates are deliberately retrieval-grounding and citation-disciplined. They do
not themselves send KB content to a remote LLM — the agent runs
`retrieve_knowledge` and decides what to do with the results under whatever LLM
the client is configured to use. Per-document `kb_policy` sensitivity controls
(see [Feature Flags](feature-flags.md)) still apply to the underlying
`retrieve_knowledge` / `resources/read` calls the agent makes.

See [MCP client configuration](clients.md) for where to set the env block, and
[MCP resources and `kb://` URIs](mcp-resources.md) for the resources surface.
