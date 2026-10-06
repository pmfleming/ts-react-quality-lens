"""Retained QML campaign integrity; does not substitute for rerunning the campaign."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


class SiblingCampaignTest(unittest.TestCase):
    def test_complete_pinned_matrix(self):
        report = json.loads((ROOT / "qml-project-results.json").read_text())
        self.assertEqual(report["consumer_revision"], "fdd92bcc096c3acfc3ef5bab564776b34b84657e")
        self.assertRegex(report["runtime_source_sha256"], r"^[a-f0-9]{64}$")
        rows = report["observations"]
        expected = {(profile, repetition, temperature) for profile in ("focused", "audit")
                    for repetition in (1, 2, 3) for temperature in ("cold", "warm")}
        self.assertEqual(len(rows), 12)
        self.assertEqual({(row["profile"], row["repetition"], row["temperature"]) for row in rows}, expected)
        for profile in ("focused", "audit"):
            samples = [row for row in rows if row["profile"] == profile]
            self.assertEqual(len({row["semantic_sha256"] for row in samples}), 1)
            for row in samples:
                self.assertEqual(row["node"], "v24.21.0")
                self.assertGreater(row["duration_ms"], 0)
                self.assertGreater(row["node_peak_rss_kib"], 0)
                self.assertRegex(row["raw_sha256"], r"^[a-f0-9]{64}$")
                self.assertEqual(row["analysis_identity"]["rulesets"]["determinism"], "semantic-boundary-v3")
                if profile == "audit":
                    self.assertTrue(row["audit"]["complete"])
                    self.assertEqual(row["audit"]["verdict"], "pass")
                    self.assertFalse(row["audit"]["incomplete_reasons"])


if __name__ == "__main__":
    unittest.main()
