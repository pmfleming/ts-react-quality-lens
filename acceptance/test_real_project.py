"""Structural integrity of retained observations; not a substitute for rerunning them."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


class RealProjectEvidenceTest(unittest.TestCase):
    def test_complete_repeatability_matrix_is_retained(self):
        report = json.loads((ROOT / "my-star-quest-results.json").read_text())
        self.assertEqual(report["consumer_revision"], "9ceeb3f4502777823dd5fb58a851614d0875763d")
        self.assertFalse(report["lens_dirty"])
        rows = report["observations"]
        expected = {(scope, profile, repetition, temperature)
                    for scope in ("app", "functions") for profile in ("focused", "audit")
                    for repetition in (1, 2, 3) for temperature in ("cold", "warm")}
        self.assertEqual(len(rows), len(expected))
        self.assertEqual({(row["scope"], row["profile"], row["repetition"], row["temperature"]) for row in rows}, expected)
        for scope in ("app", "functions"):
            for profile in ("focused", "audit"):
                samples = [row for row in rows if row["scope"] == scope and row["profile"] == profile]
                self.assertEqual(len({row["semantic_sha256"] for row in samples}), 1)
                for row in samples:
                    self.assertRegex(row["raw_sha256"], r"^[a-f0-9]{64}$")
                    self.assertRegex(row["semantic_sha256"], r"^[a-f0-9]{64}$")
                    self.assertGreater(row["duration_ms"], 0)
                    self.assertGreater(row["node_peak_rss_kib"], 0)
                    self.assertEqual(row["node"], "v24.21.0")
                    self.assertTrue(row["command"])


if __name__ == "__main__":
    unittest.main()
