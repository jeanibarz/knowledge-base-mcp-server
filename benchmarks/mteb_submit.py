#!/usr/bin/env python3
"""Official MTEB submission runner for the active kb embedding model.

RFC 020 §8 (milestone M4): "run the official `mteb` package against our active
embedding model (Qwen3-Embedding-0.6B and any successor under RFC 013) and, if
the result is competitive, open the leaderboard PR."

The runner is deliberately consistent with benchmarks/optuna_tune.py: the heavy
optional dependency (`mteb`) is imported ONLY when this script is invoked, the
embedding model id is resolved from the kb provider env (mirroring
src/config/provider.ts), and the per-task results the package writes are folded
into one record the TS side (benchmarks/mteb/result.ts) renders into a report.

Two embedding-source modes:
  --source=sentence-transformers   Load mtebModelId via mteb's SentenceTransformer
                                    loader (needs the HF weights locally/cached).
  --source=kb-endpoint              Embed via a kb-compatible OpenAI /v1/embeddings
                                    endpoint (e.g. an Ollama-backed server), so the
                                    EXACT served model the product ships is ranked.

Example:
  python3 benchmarks/mteb_submit.py \
    --provider=ollama \
    --tasks=SciFact,NFCorpus \
    --source=kb-endpoint \
    --embedding-endpoint=http://localhost:11434/v1 \
    --output=benchmarks/results/mteb/qwen3-embedding-0.6b.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# The kb provider defaults, mirrored from src/config/provider.ts so the MTEB run
# ranks the SAME model the product ships (RFC 020 §8 faithfulness property).
KB_PROVIDER_DEFAULTS: dict[str, dict[str, Any]] = {
    "ollama": {"kb_model": "dengcao/Qwen3-Embedding-0.6B:Q8_0", "mteb_model_id": "Qwen/Qwen3-Embedding-0.6B"},
    "huggingface": {"kb_model": "BAAI/bge-small-en-v1.5", "mteb_model_id": "BAAI/bge-small-en-v1.5"},
    "openai": {"kb_model": "text-embedding-3-small", "mteb_model_id": "text-embedding-3-small"},
}


def main() -> int:
    args = parse_args()
    provider = (args.provider or os.environ.get("EMBEDDING_PROVIDER") or "ollama").lower()
    defaults = KB_PROVIDER_DEFAULTS.get(provider)
    if defaults is None:
        print(f"mteb_submit: unknown provider {provider!r}; known: {', '.join(KB_PROVIDER_DEFAULTS)}", file=sys.stderr)
        return 2
    mteb_model_id = args.model or defaults["mteb_model_id"]
    kb_model = args.kb_model or defaults["kb_model"]

    try:
        import mteb  # type: ignore
    except ModuleNotFoundError:
        print(
            "MTEB submission requested, but the optional Python package is not installed. "
            "Install it with `python3 -m pip install 'mteb<2'` (and the model backend you need).",
            file=sys.stderr,
        )
        return 2

    # This runner targets the mteb 1.x encoder API (`encode(sentences, **kwargs)`
    # + `mteb.MTEB(tasks=...)`). mteb 2.x replaced it with a DataLoader-based
    # `EncoderProtocol` (encode over `DataLoader[BatchedInput]`, plus required
    # `mteb_model_meta`/`similarity` members) that the lightweight
    # `KbEndpointEncoder` below does not implement — under 2.x the evaluator
    # raises "expects a SearchInterface, Encoder, or CrossEncoder". Fail loudly
    # with the pin rather than silently mis-evaluating.
    _mteb_major = int((getattr(mteb, "__version__", "1") or "1").split(".", 1)[0])
    if _mteb_major >= 2:
        print(
            f"mteb_submit: installed mteb {mteb.__version__} uses the 2.x EncoderProtocol, "
            "incompatible with this runner's kb-endpoint encoder. Pin with "
            "`python3 -m pip install 'mteb<2'`.",
            file=sys.stderr,
        )
        return 2

    tasks = [task.strip() for task in args.tasks.split(",") if task.strip()] if args.tasks else []
    if not tasks:
        print("mteb_submit: --tasks is required (comma-separated MTEB task names)", file=sys.stderr)
        return 2

    try:
        model = load_model(mteb, args, mteb_model_id)
    except Exception as err:  # noqa: BLE001 — surface any backend load failure verbatim
        print(f"mteb_submit: could not load embedding model: {err}", file=sys.stderr)
        return 2

    output_dir = Path(args.results_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    benchmark = mteb.MTEB(tasks=mteb.get_tasks(tasks=tasks))
    benchmark.run(model, output_folder=str(output_dir), verbosity=1)

    record = build_record(output_dir, mteb_model_id, kb_model, mteb_version=getattr(mteb, "__version__", None))
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"JSON: {out_path}")
    print(f"tasks: {len(record['tasks'])}  mean_main_score: {record['mean_main_score']}")
    return 0


def load_model(mteb: Any, args: argparse.Namespace, mteb_model_id: str) -> Any:
    if args.source == "kb-endpoint":
        if not args.embedding_endpoint:
            raise ValueError("--source=kb-endpoint requires --embedding-endpoint")
        return KbEndpointEncoder(args.embedding_endpoint, mteb_model_id, api_key=os.environ.get("OPENAI_API_KEY"))
    # Default: let mteb resolve the model via its SentenceTransformer loader.
    return mteb.get_model(mteb_model_id)


class KbEndpointEncoder:
    """Minimal MTEB-compatible encoder over an OpenAI-style /v1/embeddings API.

    Ranks the exact served model the product ships (Ollama-backed), not a
    re-downloaded checkpoint, which is the faithfulness property RFC 020 §8 wants.
    Implements the `encode(sentences, **kwargs) -> np.ndarray` contract MTEB uses.
    """

    def __init__(self, endpoint: str, model_id: str, api_key: str | None) -> None:
        self.endpoint = endpoint.rstrip("/")
        if not self.endpoint.endswith("/embeddings"):
            self.endpoint = f"{self.endpoint}/embeddings"
        self.model_id = model_id
        self.api_key = api_key

    # Char budget per input. Short-context embedders (e.g. Ollama
    # nomic-embed-text, 2048 tokens) return HTTP 400 on inputs that exceed their
    # context, and the served endpoint does not truncate for us — so clamp
    # client-side. ~8000 chars ≈ 2000 tokens keeps the whole document for the
    # vast majority of BEIR passages while staying under the tightest context we
    # rank; long-context models (qwen3, 32k) are unaffected in practice.
    MAX_INPUT_CHARS = 8000

    def encode(self, sentences: list[str], **_: Any) -> Any:
        import numpy as np  # type: ignore
        import urllib.request

        vectors: list[list[float]] = []
        batch_size = 32
        for start in range(0, len(sentences), batch_size):
            # Replace empties with a single space (the endpoint rejects "") and
            # truncate over-long inputs to the per-model char budget.
            batch = [(s[: self.MAX_INPUT_CHARS] or " ") for s in sentences[start : start + batch_size]]
            payload = json.dumps({"model": self.model_id, "input": batch}).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            request = urllib.request.Request(self.endpoint, data=payload, headers=headers)
            with urllib.request.urlopen(request) as response:  # noqa: S310 — local trusted endpoint
                body = json.loads(response.read().decode("utf-8"))
            for row in body.get("data", []):
                vectors.append(row["embedding"])
        return np.asarray(vectors, dtype="float32")


def build_record(results_dir: Path, mteb_model_id: str, kb_model: str, mteb_version: str | None) -> dict[str, Any]:
    tasks: list[dict[str, Any]] = []
    for json_path in sorted(results_dir.rglob("*.json")):
        try:
            blob = json.loads(json_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if "scores" not in blob and "task_name" not in blob:
            continue
        split, main_score = extract_main_score(blob.get("scores", {}))
        tasks.append(
            {
                "task": blob.get("task_name", json_path.stem),
                "task_type": blob.get("task_type", "unknown"),
                "split": split,
                "main_score": main_score,
                "metric": "main_score",
            }
        )
    mean_main = round(sum(t["main_score"] for t in tasks) / len(tasks), 6) if tasks else None
    return {
        "schema_version": "kb.mteb-result.v1",
        "kb_model": kb_model,
        "mteb_model_id": mteb_model_id,
        "mteb_version": mteb_version,
        "tasks": tasks,
        "mean_main_score": mean_main,
    }


def extract_main_score(scores: dict[str, Any]) -> tuple[str, float]:
    for split in ("test", "validation", "dev", *scores.keys()):
        entries = scores.get(split)
        if isinstance(entries, list) and entries:
            first = entries[0]
            value = first.get("main_score") if isinstance(first, dict) else None
            if isinstance(value, (int, float)):
                return split, float(value)
    return "unknown", 0.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the official MTEB package against the active kb embedding model.")
    parser.add_argument("--provider", help="kb embedding provider (ollama|huggingface|openai). Default: $EMBEDDING_PROVIDER or ollama.")
    parser.add_argument("--model", help="Override the MTEB/HF model id (default: resolved from provider).")
    parser.add_argument("--kb-model", help="Override the kb-local model id recorded in the result.")
    parser.add_argument("--tasks", help="Comma-separated MTEB task names (e.g. SciFact,NFCorpus).")
    parser.add_argument("--source", choices=["sentence-transformers", "kb-endpoint"], default="sentence-transformers")
    parser.add_argument("--embedding-endpoint", help="OpenAI-style /v1 base URL for --source=kb-endpoint.")
    parser.add_argument("--results-dir", default="benchmarks/.cache/mteb", help="Where mteb writes per-task JSON.")
    parser.add_argument("--output", default="benchmarks/results/mteb/mteb-result.json", help="Folded result record path.")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(main())
