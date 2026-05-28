#!/usr/bin/env python3
"""Optional Optuna runner for kb benchmarks.

The runner is deliberately generic: it proposes environment variables, runs a
benchmark command, reads the emitted JSON artifact, and returns one metric to
Optuna. Optuna is only imported when this script is invoked.

Example:
  python3 benchmarks/optuna_tune.py \
    --trials=20 \
    --direction=minimize \
    --metric=scenarios.warm_query.p95_ms \
    --param-int=BENCH_FIXTURE_CHUNK_CHARS=256:1536:128 \
    -- npm run bench
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()

    try:
        import optuna  # type: ignore
    except ModuleNotFoundError:
        print(
            "Optuna tuning requested, but the optional Python package is not installed. "
            "Install it with `python3 -m pip install optuna`.",
            file=sys.stderr,
        )
        return 2

    if not args.command:
        print("bench:optuna: missing benchmark command after `--`", file=sys.stderr)
        return 2

    study = optuna.create_study(
        direction=args.direction,
        study_name=args.study_name,
        storage=args.storage,
        load_if_exists=True,
    )

    def objective(trial: Any) -> float:
        env = os.environ.copy()
        env["BENCH_RESULTS_PREFIX"] = f"optuna-trial-{trial.number}"
        env["BENCH_OPTUNA_TRIAL"] = str(trial.number)
        for spec in args.param_int:
            name, low, high, step = parse_int_spec(spec)
            env[name] = str(trial.suggest_int(name, low, high, step=step))
        for spec in args.param_float:
            name, low, high = parse_float_spec(spec)
            env[name] = str(trial.suggest_float(name, low, high))
        for spec in args.param_categorical:
            name, choices = parse_categorical_spec(spec)
            env[name] = str(trial.suggest_categorical(name, choices))

        completed = subprocess.run(
            args.command,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"benchmark command exited {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )

        artifact_path = find_json_artifact(completed.stdout)
        report = json.loads(artifact_path.read_text(encoding="utf-8"))
        value = read_metric(report, args.metric)
        trial.set_user_attr("artifact", str(artifact_path))
        for key, val in env.items():
            if key.startswith(("BENCH_", "KB_")) and key in trial.params:
                trial.set_user_attr(key, val)
        return value

    study.optimize(objective, n_trials=args.trials)
    print(f"study: {study.study_name}")
    print(f"best_trial: {study.best_trial.number}")
    print(f"best_value: {study.best_value}")
    print(f"best_params: {json.dumps(study.best_params, sort_keys=True)}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Tune kb benchmark environment parameters with optional Optuna.",
    )
    parser.add_argument("--trials", type=int, default=20)
    parser.add_argument("--direction", choices=["minimize", "maximize"], default="maximize")
    parser.add_argument("--metric", required=True, help="Dot path in benchmark JSON, e.g. scenarios.warm_query.p95_ms")
    parser.add_argument("--study-name", default="kb-bench")
    parser.add_argument("--storage", help="Optuna storage URL, e.g. sqlite:///benchmarks/results/optuna.db")
    parser.add_argument("--param-int", action="append", default=[], metavar="NAME=LOW:HIGH[:STEP]")
    parser.add_argument("--param-float", action="append", default=[], metavar="NAME=LOW:HIGH")
    parser.add_argument("--param-categorical", action="append", default=[], metavar="NAME=A,B,C")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    parsed = parser.parse_args()
    if parsed.command and parsed.command[0] == "--":
        parsed.command = parsed.command[1:]
    return parsed


def parse_int_spec(spec: str) -> tuple[str, int, int, int]:
    name, raw = split_spec(spec)
    parts = raw.split(":")
    if len(parts) not in (2, 3):
        raise ValueError(f"invalid --param-int {spec!r}; expected NAME=LOW:HIGH[:STEP]")
    low = int(parts[0])
    high = int(parts[1])
    step = int(parts[2]) if len(parts) == 3 else 1
    return name, low, high, step


def parse_float_spec(spec: str) -> tuple[str, float, float]:
    name, raw = split_spec(spec)
    parts = raw.split(":")
    if len(parts) != 2:
        raise ValueError(f"invalid --param-float {spec!r}; expected NAME=LOW:HIGH")
    return name, float(parts[0]), float(parts[1])


def parse_categorical_spec(spec: str) -> tuple[str, list[str]]:
    name, raw = split_spec(spec)
    choices = [part for part in raw.split(",") if part]
    if not choices:
        raise ValueError(f"invalid --param-categorical {spec!r}; expected NAME=A,B,C")
    return name, choices


def split_spec(spec: str) -> tuple[str, str]:
    if "=" not in spec:
        raise ValueError(f"invalid parameter spec {spec!r}; expected NAME=...")
    name, raw = spec.split("=", 1)
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"invalid environment variable name {name!r}")
    return name, raw


def find_json_artifact(stdout: str) -> Path:
    candidates: list[str] = []
    for line in stdout.splitlines():
        text = line.strip()
        if text.startswith("JSON:"):
            candidates.append(text.split("JSON:", 1)[1].strip())
        elif text.endswith(".json"):
            candidates.append(text)
    for candidate in reversed(candidates):
        path = Path(candidate)
        if path.exists():
            return path
    raise RuntimeError(f"benchmark command did not print a readable JSON artifact path\nstdout:\n{stdout}")


def read_metric(report: Any, metric_path: str) -> float:
    cursor = report
    for part in metric_path.split("."):
        if isinstance(cursor, list):
            cursor = cursor[int(part)]
        elif isinstance(cursor, dict):
            cursor = cursor[part]
        else:
            raise KeyError(metric_path)
    if not isinstance(cursor, (int, float)):
        raise TypeError(f"metric {metric_path!r} resolved to non-numeric value {cursor!r}")
    return float(cursor)


if __name__ == "__main__":
    raise SystemExit(main())
