import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import optuna_tune


class ReplayConfigTests(unittest.TestCase):
    def test_build_replay_config_records_command_and_best_trial_environment(self) -> None:
        args = SimpleNamespace(
            command=["npm", "run", "bench:beir", "--", "--dataset=scifact"],
            direction="maximize",
            metric="metrics.ndcgAt10",
            study_name="scifact-lexical",
        )
        study = SimpleNamespace(
            best_trial=SimpleNamespace(number=3, params={"KB_CHUNK_SIZE": 384, "KB_CHUNK_OVERLAP": 48}),
            best_value=0.667,
        )

        config = optuna_tune.build_replay_config(study, args)

        self.assertEqual(config["schema_version"], "kb.benchmark-replay-config.v1")
        self.assertEqual(config["command"], ["npm", "run", "bench:beir", "--", "--dataset=scifact"])
        self.assertEqual(config["env"], {"KB_CHUNK_SIZE": "384", "KB_CHUNK_OVERLAP": "48"})
        self.assertEqual(config["best_trial"], 3)
        self.assertEqual(config["best_value"], 0.667)

    def test_replay_config_runs_recorded_command_with_recorded_environment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kb-optuna-replay-test-") as tmp:
            tmp_path = Path(tmp)
            output_path = tmp_path / "env.json"
            config_path = tmp_path / "replay.json"
            config_path.write_text(json.dumps({
                "schema_version": "kb.benchmark-replay-config.v1",
                "command": [
                    sys.executable,
                    "-c",
                    (
                        "import json, os, sys; "
                        "json.dump({'chunk': os.environ.get('KB_CHUNK_SIZE')}, open(sys.argv[1], 'w'))"
                    ),
                    str(output_path),
                ],
                "env": {
                    "KB_CHUNK_SIZE": "512",
                },
            }), encoding="utf-8")

            completed = optuna_tune.run_replay_config(config_path)

            self.assertEqual(completed.returncode, 0)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), {"chunk": "512"})

    def test_main_replays_config_without_importing_optuna(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kb-optuna-main-replay-test-") as tmp:
            tmp_path = Path(tmp)
            output_path = tmp_path / "env.json"
            config_path = tmp_path / "replay.json"
            config_path.write_text(json.dumps({
                "schema_version": "kb.benchmark-replay-config.v1",
                "command": [
                    sys.executable,
                    "-c",
                    (
                        "import json, os, sys; "
                        "json.dump({'chunk': os.environ.get('KB_CHUNK_SIZE')}, open(sys.argv[1], 'w'))"
                    ),
                    str(output_path),
                ],
                "env": {
                    "KB_CHUNK_SIZE": "768",
                },
            }), encoding="utf-8")

            with patch.object(sys, "argv", ["optuna_tune.py", f"--replay-config={config_path}"]):
                exit_code = optuna_tune.main()

            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), {"chunk": "768"})


if __name__ == "__main__":
    unittest.main()
