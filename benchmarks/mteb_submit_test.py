import json
import tempfile
import unittest
from pathlib import Path

import mteb_submit


class ExtractMainScoreTests(unittest.TestCase):
    def test_prefers_test_split_main_score(self) -> None:
        split, score = mteb_submit.extract_main_score({"test": [{"main_score": 0.751}]})
        self.assertEqual(split, "test")
        self.assertAlmostEqual(score, 0.751)

    def test_falls_back_when_no_recognised_split(self) -> None:
        split, score = mteb_submit.extract_main_score({})
        self.assertEqual(split, "unknown")
        self.assertEqual(score, 0.0)


class BuildRecordTests(unittest.TestCase):
    def test_folds_per_task_json_into_one_record(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kb-mteb-test-") as tmp:
            results_dir = Path(tmp)
            (results_dir / "SciFact.json").write_text(
                json.dumps({"task_name": "SciFact", "task_type": "Retrieval", "scores": {"test": [{"main_score": 0.75}]}}),
                encoding="utf-8",
            )
            (results_dir / "NFCorpus.json").write_text(
                json.dumps({"task_name": "NFCorpus", "task_type": "Retrieval", "scores": {"test": [{"main_score": 0.35}]}}),
                encoding="utf-8",
            )

            record = mteb_submit.build_record(
                results_dir,
                mteb_model_id="Qwen/Qwen3-Embedding-0.6B",
                kb_model="dengcao/Qwen3-Embedding-0.6B:Q8_0",
                mteb_version="1.14.0",
            )

            self.assertEqual(record["schema_version"], "kb.mteb-result.v1")
            self.assertEqual(len(record["tasks"]), 2)
            self.assertAlmostEqual(record["mean_main_score"], 0.55)
            self.assertEqual(record["mteb_model_id"], "Qwen/Qwen3-Embedding-0.6B")

    def test_empty_results_dir_yields_no_mean(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kb-mteb-empty-") as tmp:
            record = mteb_submit.build_record(Path(tmp), "id", "kb", None)
            self.assertEqual(record["tasks"], [])
            self.assertIsNone(record["mean_main_score"])


class ProviderDefaultsTests(unittest.TestCase):
    def test_known_providers_resolve_to_mteb_ids(self) -> None:
        self.assertEqual(
            mteb_submit.KB_PROVIDER_DEFAULTS["ollama"]["mteb_model_id"],
            "Qwen/Qwen3-Embedding-0.6B",
        )


if __name__ == "__main__":
    unittest.main()
