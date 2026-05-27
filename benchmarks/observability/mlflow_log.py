#!/usr/bin/env python3
"""Optional MLflow bridge for kb benchmark runs.

This script is intentionally imported only when BENCH_MLFLOW_* is set. The
normal benchmark path has no Python or MLflow dependency.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: mlflow_log.py <payload.json>", file=sys.stderr)
        return 2

    try:
        import mlflow  # type: ignore
    except ModuleNotFoundError:
        print(
            "MLflow logging requested, but the optional Python package is not installed. "
            "Install it with `python3 -m pip install mlflow` or unset BENCH_MLFLOW_*.",
            file=sys.stderr,
        )
        return 2

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    tracking_uri = payload.get("tracking_uri")
    if tracking_uri:
        mlflow.set_tracking_uri(tracking_uri)

    mlflow.set_experiment(payload["experiment_name"])
    with mlflow.start_run(run_name=payload.get("run_name")):
        tags: dict[str, str] = payload.get("tags", {})
        if tags:
            mlflow.set_tags(tags)

        params: dict[str, str] = payload.get("params", {})
        if params:
            mlflow.log_params(params)

        metrics: dict[str, float] = payload.get("metrics", {})
        for key, value in metrics.items():
            if isinstance(value, (int, float)):
                mlflow.log_metric(key, float(value))

        for artifact in payload.get("artifacts", []):
            path = Path(artifact)
            if path.exists():
                mlflow.log_artifact(str(path))

        mlflow.log_dict(_compact_payload(payload), "kb_benchmark_payload.json")

    return 0


def _compact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "experiment_name": payload.get("experiment_name"),
        "run_name": payload.get("run_name"),
        "tracking_uri": payload.get("tracking_uri"),
        "tags": payload.get("tags", {}),
        "params": payload.get("params", {}),
        "metric_count": len(payload.get("metrics", {})),
        "artifacts": payload.get("artifacts", []),
    }


if __name__ == "__main__":
    raise SystemExit(main())
