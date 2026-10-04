#!/usr/bin/env python3
"""Pinned MyStarQuest repeatability campaign. No install, deploy or source mutation.

Run after building the lens and installing the consumer lockfiles under its supported
runtime. Each cold sample empties only this campaign's lens cache; OS caches stay warm.
Raw and semantic snapshots are retained outside the consumer and source repository.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

PIN = "9ceeb3f4502777823dd5fb58a851614d0875763d"
LENS = pathlib.Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    project, output = args.project.resolve(), args.output.resolve()
    if git(project, "rev-parse", "HEAD") != PIN or git(project, "status", "--porcelain"):
        raise SystemExit("A clean, pinned MyStarQuest checkout is required")
    if output.is_relative_to(project) or output.is_relative_to(LENS):
        raise SystemExit("Campaign output must be outside consumer and lens repositories")
    if args.repetitions < 3:
        raise SystemExit("At least three cold/warm pairs are required")
    output.mkdir(parents=True, exist_ok=True)
    observations = []
    for scope in ("app", "functions"):
        for profile in ("focused", "audit"):
            workspace = output / f"{scope}-{profile}"
            workspace.mkdir(exist_ok=True)
            for repetition in range(args.repetitions):
                shutil.rmtree(workspace / "artifacts" / ".cache", ignore_errors=True)
                for temperature in ("cold", "warm"):
                    command = ["node", str(LENS / "dist/scripts/trust-campaign.js"), str(project), str(workspace), profile, scope]
                    run = subprocess.run(command, text=True, capture_output=True, cwd=LENS, timeout=600)
                    label = f"{scope}-{profile}-{repetition + 1}-{temperature}"
                    (output / f"{label}.stderr").write_text(run.stderr)
                    if run.returncode:
                        (output / f"{label}.stdout").write_text(run.stdout)
                        raise SystemExit(f"{label} failed: {run.stderr[-2000:]}")
                    row = json.loads(run.stdout)
                    row.update(repetition=repetition + 1, temperature=temperature, command=command)
                    for kind in ("raw", "semantic"):
                        source = workspace / f"snapshot.{kind}.json"
                        target = output / f"{label}.{kind}.json"
                        shutil.copyfile(source, target)
                        row[f"{kind}_sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
                    observations.append(row)
                    print(label, row["duration_ms"], row["semantic_sha256"], flush=True)
                    save(output, project, observations)
    failed = []
    for scope in ("app", "functions"):
        for profile in ("focused", "audit"):
            hashes = {row["semantic_sha256"] for row in observations if row["scope"] == scope and row["profile"] == profile}
            if len(hashes) != 1:
                failed.append(f"{scope}/{profile}")
    if failed:
        raise SystemExit("Investigate semantic differences: " + ", ".join(failed))


def save(output, project, observations):
    report = {"consumer_revision": PIN, "lens_revision": git(LENS, "rev-parse", "HEAD"),
              "lens_dirty": bool(git(LENS, "status", "--porcelain")),
              "consumer_lock_sha256": {str(file.relative_to(project)): hashlib.sha256(file.read_bytes()).hexdigest()
                                       for file in [project / "package-lock.json", project / "functions/package-lock.json"]},
              "observations": observations}
    (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
