# TEI as the embedding server

Use this runbook when you want fast bulk (re)indexing from a local GPU while
keeping the embedding server small in VRAM. It describes running Hugging Face
[Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference)
(TEI) and pointing `kb` at it through the existing OpenAI-compatible provider.
No new provider is needed: TEI serves `/v1/embeddings`, and `kb` reaches it with
`EMBEDDING_PROVIDER=openai` plus `OPENAI_BASE_URL`.

## Why TEI

Measured with Qwen3-Embedding-0.6B on a shared RTX 3090 under WSL (one engine
resident at a time, tuned for minimal footprint, 512 unique ~1000-character
chunks, peak VRAM sampled against a pre-start baseline, about +/-0.3 GB noise).
Throughput is chunks per second at `INDEXING_BATCH_SIZE` x `KB_INDEXING_CONCURRENCY`.

| Engine and config | Peak VRAM added | Batch 16 x1 | Batch 64 x1 | Batch 64 x4 | Query p50 | Cosine / top-5 vs fp32 |
| --- | --- | --- | --- | --- | --- | --- |
| TEI 1.9.4 fp16 (`--max-batch-tokens 4096 --max-client-batch-size 64`) | 1.65-1.85 GB | 75 | 94-96 | 104-107 | 38-44 ms | 0.99988 / 0.98 |
| vLLM 0.33 fp16 (`--enforce-eager`, 256 MB KV, 4096 batched tokens) | 1.9-2.3 GB | 69-79 | 90-91 | 106-114 | ~60 ms | 0.99981 / 0.98 |
| vLLM 0.33 FP8 | 1.8-1.9 GB | 42-75 | 57-92 | 66-111 | 54-109 ms | 0.99717 / 0.94 |
| Ollama 0.40.16 Q8_0 (1 parallel slot, 2048 context, flash attention) | 1.4-1.9 GB | 30-33 | 33-36 | 32-36 | 22-29 ms | 0.99922 / 0.94 |
| Ollama 0.40.16 Q4_K_M | 1.0-1.15 GB | 27 | 26-29 | 26-27 | ~32 ms | 0.97378 / 0.80 |
| llama-server b9775 Q8_0 (`-np 4 -c 4096 -ub 1024`) | 2.0-2.3 GB | 10-13 | 10-13 | 10-14 | 18-21 ms | 0.9992 / 0.98 |
| Reference: Ollama 0.30.10 Q8_0 as loaded in production (16k context) | about 3.8 GB | 11.7 | - | - | 234 ms | 0.99923 / 0.94 |

TEI has the fastest bulk indexing (tied with vLLM) at the lowest VRAM of the
fast engines, is the most faithful (fp16), and starts in about 20 s. Reindexing
is about 9x faster than Ollama 0.30.10 and about 3x faster than Ollama 0.40.16.
Q4 and FP8 are not worth it for this model: they saved at most 0.5 GB and Q4
changed 20% of top-5 results. Use Q8 or fp16. Ollama 0.40.16 is the
zero-change fallback if you do not want a second runtime.

## Start the server

```bash
docker run -d --name tei --gpus all -p 18102:80 \
  -v tei-cache:/data \
  ghcr.io/huggingface/text-embeddings-inference:86-1.9.4 \
  --model-id Qwen/Qwen3-Embedding-0.6B \
  --max-batch-tokens 4096 \
  --max-client-batch-size 64
```

The image tag selects the CUDA architecture: `86-1.9.4` is for Ampere
(RTX 30xx / A-series). Use the matching tag from the TEI README for other GPUs.
`--max-batch-tokens 4096` and `--max-client-batch-size 64` are what keep VRAM
near 1.7 GB; raising them grows VRAM.

## Point `kb` at it

```bash
export EMBEDDING_PROVIDER=openai
export OPENAI_BASE_URL=http://127.0.0.1:18102/v1
export OPENAI_API_KEY=local            # required by kb; TEI ignores it
export OPENAI_MODEL_NAME=Qwen/Qwen3-Embedding-0.6B
export INDEXING_BATCH_SIZE=64
export KB_INDEXING_CONCURRENCY=4       # about 105 chunks/s in the table above
```

Constraints:

- `INDEXING_BATCH_SIZE` must not exceed TEI's `--max-client-batch-size`; TEI
  rejects larger requests with HTTP 413/422. `kb` sends at most
  `INDEXING_BATCH_SIZE` inputs per request.
- Switching from Ollama to TEI changes the model id (`openai__...` instead of
  `ollama__...`), so `kb` builds a fresh index for it. Add it side by side with
  `kb models add openai Qwen/Qwen3-Embedding-0.6B`, verify, then
  `kb models set-active`.
- Qwen3 query instructions still apply (`KB_EMBEDDING_TASK_PREFIXES`); model
  matching is on the model name, not the provider.
- TEI model compatibility beyond Qwen3 and ModernBERT-based models is unverified:
  check Jina v5-nano (EuroBERT) and EmbeddingGemma-2 before relying on them.
  Qwen3-Embedding-4B does not fit the VRAM budget (fp16 weights alone are 8 GB).

## Verify

```bash
curl -s http://127.0.0.1:18102/health
kb models add openai Qwen/Qwen3-Embedding-0.6B
kb search "test query" --timing
```

## Client behaviour

For the `ollama` and `openai` providers `kb` uses a small built-in `fetch`
client (no `@langchain/ollama` / `@langchain/openai`). It sends text unchanged,
retries only transient failures (network drop, HTTP 5xx/429) up to 2 times, and
maps HTTP 401/403 to `PROVIDER_AUTH`.

Upgrade note: the previous OpenAI client replaced newlines with spaces before
embedding. The built-in client sends text byte-for-byte, so vectors for text
containing newlines differ slightly. Reindex existing `openai__*` indexes so
query and document vectors are produced the same way. Ollama vectors are
unaffected.
