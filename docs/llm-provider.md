# LLM provider configuration

`kb`'s chat-completion calls — `kb ask`, contextual-retrieval prefaces
(RFC 017), the relevance-gate judge (RFC 018), and `kb llm probe` — route through a
**provider-neutral, OpenAI-compatible** config layer. A single switch moves the
active chat model between:

- **`local`** (default) — a localhost OpenAI-compatible server such as the RFC
  015 `llama-server` profile. No authentication header.
- **`openrouter`** — OpenRouter's hosted OpenAI-compatible API, e.g.
  `deepseek/deepseek-v4-flash`. Requires an API key.

This mirrors the same switch in the sibling repos
([`local-research-agent`](https://github.com/jeanibarz/local-research-agent)'s
`LRA_LLM_*`, `kookr`'s `KOOKR_LLM_*`) so one DeepSeek/OpenRouter setup is
consistent across all three. **Embeddings are unaffected** — they always run
locally through the configured embedding provider (e.g. nomic via Ollama). Only
the *generation* step (answers, prefaces, gate judging) is switched here.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `KB_LLM_PROVIDER` | `local` | `local` or `openrouter`. |
| `KB_LLM_ENDPOINT` | — | Chat-completions URL. For OpenRouter: `https://openrouter.ai/api/v1/chat/completions`. |
| `KB_LLM_MODEL` | provider default | Model id. OpenRouter defaults to `deepseek/deepseek-v4-flash` when unset. |
| `KB_OPENROUTER_API_KEY` | — | OpenRouter key (preferred). Sent as `Authorization: Bearer …`; never logged. |
| `OPENROUTER_API_KEY` | — | Shared fallback key (used if `KB_OPENROUTER_API_KEY` is unset). |
| `KB_LLM_APP_TITLE` | `knowledge-base-mcp` | OpenRouter `X-Title` attribution header. |
| `KB_LLM_HTTP_REFERER` | — | Optional OpenRouter `HTTP-Referer` attribution header. |

The relevance gate keeps its existing `KB_GATE_LLM_ENDPOINT` / `KB_GATE_LLM_MODEL`
overrides, which fall back to `KB_LLM_ENDPOINT` / `KB_LLM_MODEL`. Auth resolves
centrally, so the gate judge picks up OpenRouter automatically.

## Switch to OpenRouter (DeepSeek)

Put these in the package-root gitignored `.env` (auto-loaded at CLI start; real
process-env values always win), or export them in your shell:

```bash
KB_LLM_PROVIDER=openrouter
KB_LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
KB_LLM_MODEL=deepseek/deepseek-v4-flash
KB_OPENROUTER_API_KEY=sk-or-v1-...        # preferred (kb's own credit/limit)
# OPENROUTER_API_KEY=sk-or-v1-...         # or the shared fallback
KB_LLM_APP_TITLE=knowledge-base-mcp       # optional attribution
```

Minimal switch: `KB_LLM_PROVIDER=openrouter` + a key (endpoint and model fall
back to OpenRouter + DeepSeek defaults). To go back to local, set
`KB_LLM_PROVIDER=local` (or remove the vars).

**API-key precedence:** `KB_OPENROUTER_API_KEY` first, then `OPENROUTER_API_KEY`
— the component-specific variable lets `kb`, LRA, and kookr hold separate
OpenRouter keys with separate credit limits, while single-key setups can just set
`OPENROUTER_API_KEY`.

## Verify

```bash
kb llm probe --endpoint=https://openrouter.ai/api/v1/chat/completions
# → { "chat_ok": true, "detail": "chat completion succeeded; remote provider (health check skipped)" }
```

Hosted providers expose no `/health` route, so the probe (and `kb doctor`) skip
the health GET for remote providers and judge readiness by the chat call alone.

## Privacy note

With `openrouter`, the **content sent to the model leaves your machine** — for
contextual prefaces that means each eligible chunk's text is sent to OpenRouter.
Sources marked `kb_policy.no_llm_context: true` remain retrieval-only and are not
sent. This is a deliberate shift from the local-first default; embeddings still
run locally.

## Behavioral differences (local vs remote)

- **Auth:** remote sends `Authorization: Bearer`, `X-Title`, and optional
  `HTTP-Referer`; local sends none.
- **Request body:** the `chat_template_kwargs` llama.cpp/vLLM extension is sent
  only for local endpoints (hosted providers reject/ignore unknown fields).
- **Health probe:** skipped for remote providers (no `/health`).
- **Streaming:** markdown `kb ask` output opts into OpenAI-compatible SSE
  streaming and prints answer tokens as they arrive, then renders sources,
  context, timing, and transcript status after the final answer. Use
  `kb ask --no-stream` to keep the old wait-then-print markdown behavior.
  `--format=json`, contextual prefaces, relevance-gate calls, and probes remain
  non-streaming. Streaming calls retry only before the first answer token is
  emitted; after output starts, stream errors are surfaced without replaying
  partial content. The streaming timeout is idle/inter-chunk, while non-streaming
  calls keep the existing request timeout behavior.
