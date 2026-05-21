# Fake LLM Fixture

Use the fake LLM when developing LLM-dependent paths without a local model:

```bash
KB_LLM_FAKE=on kb ask "Who approves rollback?" --kb=ops
KB_LLM_FAKE=on KB_RELEVANCE_GATE=on kb search "rollback approval" --gate --task-context="answer an operations question"
KB_LLM_FAKE=on KB_CONTEXTUAL_RETRIEVAL=on kb reindex --with-context
```

`KB_LLM_FAKE=on` routes every `callChatCompletion` call to an in-process
deterministic responder and ignores `KB_LLM_ENDPOINT`. It covers:

- RFC 018 relevance-gate Stage B judge calls.
- RFC 017 contextual-preface generation.
- `kb ask` final-answer calls.

The fake also has a standalone OpenAI-compatible server for end-to-end clients
that need a real HTTP endpoint:

```bash
npm run dev:mockllm -- --port=18080
KB_LLM_ENDPOINT=http://127.0.0.1:18080/v1/chat/completions kb ask "Who approves rollback?"
```

The server implements:

- `GET /health`
- `POST /v1/chat/completions`

## Rules File

Set `KB_LLM_FAKE_RULES=/path/to/rules.json` or pass
`npm run dev:mockllm -- --rules=/path/to/rules.json`.

```json
{
  "answers": [
    {
      "question_contains": "rollback",
      "answer": "Rollback approval requires the release lead. Source: ops/runbooks/rollback.md."
    }
  ],
  "prefaces": [
    {
      "chunk_contains": "release lead",
      "preface": "In section \"Rollback\", this chunk explains approval ownership."
    }
  ],
  "judge": [
    {
      "query_contains": "rollback",
      "keep_contains": ["rollback", "release lead"],
      "overall": "relevant"
    }
  ],
  "responses": [
    {
      "user_contains": "health check",
      "content": "ok"
    }
  ],
  "default_response": "Fake LLM response from kb-fake-llm."
}
```

Rules are matched case-insensitively. Defaults are deterministic: the judge
keeps candidates whose content overlaps query/task terms, contextual prefaces
use the nearest Markdown heading, and `kb ask` answers from the first packed
snippet or abstains when no snippets are present.
