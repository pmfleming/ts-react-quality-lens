#!/usr/bin/env python3
"""Read-only-source QML consumer campaign; outputs and caches must be external."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

LENS = pathlib.Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    args = parser.parse_args()
    project, output = args.project.resolve(), args.output.resolve()
    if git(project, "status", "--porcelain"):
        raise SystemExit("A clean QML checkout is required")
    if output.is_relative_to(project) or output.is_relative_to(LENS):
        raise SystemExit("Output must be outside both repositories")
    output.mkdir(parents=True, exist_ok=True)
    revision = git(project, "rev-parse", "HEAD")
    source = hashlib.sha256()
    for file in sorted([*LENS.glob("src/**/*.ts"), *LENS.glob("scripts/**/*.ts"), *LENS.glob("bin/**/*.ts"), LENS / "package.json", LENS / "package-lock.json"]):
        source.update(str(file.relative_to(LENS)).encode() + b"\0" + file.read_bytes() + b"\0")
    report = {"consumer_revision": revision, "lens_base_revision": git(LENS, "rev-parse", "HEAD"),
              "lens_dirty": bool(git(LENS, "status", "--porcelain")), "runtime_source_sha256": source.hexdigest(),
              "scope": "QML lens TypeScript implementation; not Qt/QML semantic accuracy or a resource budget", "observations": []}
    for profile in ("focused", "audit"):
        workspace = output / profile
        for repetition in (1, 2, 3):
            shutil.rmtree(workspace / "artifacts" / ".cache", ignore_errors=True)
            for temperature in ("cold", "warm"):
                command = ["node", str(LENS / "dist/scripts/trust-campaign.js"), str(project), str(workspace), profile, "app"]
                run = subprocess.run(command, cwd=LENS, text=True, capture_output=True, timeout=900)
                label = f"{profile}-{repetition}-{temperature}"
                (output / f"{label}.stderr").write_text(run.stderr)
                if run.returncode:
                    raise SystemExit(f"{label} failed: {run.stderr[-4000:]}")
                row = json.loads(run.stdout)
                row.pop("capabilities", None)
                row.update(repetition=repetition, temperature=temperature, command=command)
                for kind in ("raw", "semantic"):
                    target = output / f"{label}.{kind}.json"
                    shutil.copyfile(workspace / f"snapshot.{kind}.json", target)
                    row[f"{kind}_sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
                report["observations"].append(row)
                (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
                print(label, row["semantic_sha256"], flush=True)
    if git(project, "rev-parse", "HEAD") != revision or git(project, "status", "--porcelain"):
        raise SystemExit("Consumer changed during the campaign")
    for profile in ("focused", "audit"):
        if len({row["semantic_sha256"] for row in report["observations"] if row["profile"] == profile}) != 1:
            raise SystemExit(f"Investigate semantic differences in {profile}; raw evidence retained")


if __name__ == "__main__":
    main()
