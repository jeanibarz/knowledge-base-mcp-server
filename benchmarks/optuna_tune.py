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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()

    if args.replay_config is not None:
        return run_replay_config(Path(args.replay_config)).returncode

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
    if args.metric is None:
        print("bench:optuna: --metric is required unless --replay-config is used", file=sys.stderr)
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
    best_config_path = write_replay_config(study, args)
    print(f"study: {study.study_name}")
    print(f"best_trial: {study.best_trial.number}")
    print(f"best_value: {study.best_value}")
    print(f"best_params: {json.dumps(study.best_params, sort_keys=True)}")
    print(f"best_config: {best_config_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Tune kb benchmark environment parameters with optional Optuna.",
    )
    parser.add_argument("--trials", type=int, default=20)
    parser.add_argument("--direction", choices=["minimize", "maximize"], default="maximize")
    parser.add_argument("--metric", help="Dot path in benchmark JSON, e.g. scenarios.warm_query.p95_ms")
    parser.add_argument("--study-name", default="kb-bench")
    parser.add_argument("--storage", help="Optuna storage URL, e.g. sqlite:///benchmarks/results/optuna.db")
    parser.add_argument("--best-config-out", help="Replay config path. Defaults to benchmarks/results/<study-name>-best-config.json")
    parser.add_argument("--replay-config", help="Run a generated replay config without importing Optuna")
    parser.add_argument("--param-int", action="append", default=[], metavar="NAME=LOW:HIGH[:STEP]")
    parser.add_argument("--param-float", action="append", default=[], metavar="NAME=LOW:HIGH")
    parser.add_argument("--param-categorical", action="append", default=[], metavar="NAME=A,B,C")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    parsed = parser.parse_args()
    if parsed.command and parsed.command[0] == "--":
        parsed.command = parsed.command[1:]
    return parsed


def build_replay_config(study: Any, args: argparse.Namespace) -> dict[str, Any]:
    best_trial = study.best_trial
    env = {str(name): str(value) for name, value in best_trial.params.items()}
    return {
        "schema_version": "kb.benchmark-replay-config.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "study_name": args.study_name,
        "direction": args.direction,
        "metric": args.metric,
        "best_trial": best_trial.number,
        "best_value": study.best_value,
        "command": list(args.command),
        "env": env,
        "params": dict(best_trial.params),
    }


def write_replay_config(study: Any, args: argparse.Namespace) -> Path:
    output_path = Path(args.best_config_out) if args.best_config_out else default_best_config_path(args.study_name)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(build_replay_config(study, args), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output_path


def default_best_config_path(study_name: str) -> Path:
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", study_name).strip("-") or "kb-bench"
    return Path("benchmarks") / "results" / f"{safe_name}-best-config.json"


def run_replay_config(config_path: Path) -> subprocess.CompletedProcess[str]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("replay config must contain a JSON object")
    if config.get("schema_version") != "kb.benchmark-replay-config.v1":
        raise ValueError("replay config schema_version must be kb.benchmark-replay-config.v1")
    command = config.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
        raise ValueError("replay config command must be a non-empty string array")
    env_config = config.get("env", {})
    if not isinstance(env_config, dict) or not all(isinstance(name, str) and isinstance(value, str) for name, value in env_config.items()):
        raise ValueError("replay config env must be an object of string values")

    env = os.environ.copy()
    env.update(env_config)
    return subprocess.run(command, env=env, text=True, check=False)


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
