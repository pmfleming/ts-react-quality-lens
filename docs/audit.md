# Audit reference

`audit` runs quality/correctness measurements, reads their current records and clone groups, applies policy and suppressions, and writes `output_dir/audit.json`. It does not refresh `map.json` or `context.json`.

```sh
node ./dist/bin/ts-react-quality-lens.js audit --config ./ts-react-quality-lens.config.json --base origin/main --gate new-only --format markdown
```

## Options

| Flag | Behavior |
| --- | --- |
| `--base REF` | Compare against the merge base of REF and HEAD. |
| `--changed-since REF` | Same kind of Git ref as `--base`, with higher precedence. |
| `--gate new-only` | Gate introduced findings only (default). |
| `--gate all` | Gate all unsuppressed findings retained in audit scope, including inherited findings. It does not force a whole-project scan scope when a valid diff exists. |
| `--baseline PATH` | Suppress finding IDs from a saved baseline; overrides `audit.baseline`. |
| `--save-baseline PATH` | Save all IDs retained in this audit, including inherited/suppressed findings. Does not alter this run's verdict or automatically save every project finding. |
| `--format summary` | Print a compact JSON summary (default). |
| `--format json` | Print the complete audit artifact. |
| `--format markdown` | Print a PR-ready Markdown summary. |

All formats still write the full JSON artifact. Relative baseline flags resolve from the shell working directory; `audit.baseline` in config resolves from the config directory.

## Change scope and attribution

Base selection precedence is:

1. CLI `--changed-since`.
2. CLI `--base`.
3. Config `audit.changed_since`.
4. Config `audit.base`.
5. `origin/main`, if it exists locally.

The lens diffs the merge base against the **working tree**, not just committed HEAD. It includes committed branch changes, staged and unstaged edits, and untracked nonignored files. Deleted files can be in the change list but do not produce current source records.

For a valid comparison, the lens creates a temporary detached Git worktree at the merge base, loads that tree's config, reuses installed dependencies through symlinks, and measures the base **without running tests**. It does not install dependencies. The config must exist in the base and resolve to the expected base project root.

If base and current `analysis_identity.id` match:

- an ID present in the base is inherited (`introduced: false`), even if its location is now in a changed hunk;
- an ID absent from the base is introduced, including findings in unchanged consumer files;
- inherited findings are retained when they touch changed files, with project-scoped findings retained as project context.

Compiler, typed-lint, React Hooks, and jsx-a11y records use semantic occurrence fingerprints to tolerate line movement while preserving duplicate occurrences. These fingerprints still include the file, message, and source anchor; they are not guaranteed stable across renames or code changes. Other producers have their own ID schemes.

If compatible snapshot IDs are unavailable, locations/hunks provide fallback attribution. A valid diff with no changes does not expand to all file findings, though project-scoped findings can still appear. If an attempted Git comparison fails, the audit reports incomplete evidence and falls back to whole-project finding collection rather than claiming a clean empty diff.

**If no base is configured and `origin/main` does not exist**, audit uses whole-project scope and marks collected findings introduced; the absence of a base alone does not make this mode incomplete. Set `--base` explicitly in CI when changed-code comparison is required.

An unavailable base snapshot after a valid diff, or a mismatched compiler/config/ruleset/integration identity, adds an incomplete reason. Configuration, manifest, and lockfile changes can therefore prevent identity-based comparison even if the source still compiles.

## Verdict and exit status

After applying scope, configured suppressions, baselines, and policy-adjusted dispositions:

1. An active `block` finding gives **`fail`**.
2. Otherwise, missing required evidence/comparison failures give **`incomplete`**.
3. Otherwise, an active `warn` gives **`warn`**.
4. Otherwise, the verdict is **`pass`**.

The CLI exits **1** for `fail` or `incomplete`, **0** for `pass` or `warn`. A blocker takes precedence over incomplete evidence; check `summary.complete` and `summary.incomplete_reasons` even on a failed audit. Raw risk scores never select the verdict.

Required evidence checks cover compiler loading, completed typed lint, configured test execution, completed React Hooks analysis, and package validation as selected by policy. Configured runtime input failures also add an incomplete reason. SARIF input failures are instead emitted as block/warn findings according to each input's `required` flag and go through the normal gate/suppression rules. See [rule catalog](rule-catalog.md).

## Tests and trust

CLI audits run the configured or inferred project test command, regardless of whether `tests` is required by policy. Set `test_command: null` to disable it. If tests remain required, disabled execution yields incomplete evidence. A failing executed command emits a project-scoped blocker.

Commands run in the project directory with its `node_modules/.bin` prepended to PATH and a 120-second timeout. Current execution states are `passed`, `failed`, `unknown` (no command), and `not_run` (catalog only). Timeout/process errors are currently recorded as failed, not a separate timeout state. Output on failure is truncated to 4,000 characters each for stdout and stderr.

MCP audit differs: it skips tests unless the tool call explicitly supplies `run_tests: true`. Skipped required tests remain incomplete. These operations run trusted tools/configuration and are not sandboxed; neither CLI nor server analysis is guaranteed side-effect-free.

## Baselines and suppression hygiene

Saved baselines have this shape:

```json
{ "findings": ["finding-id-1", "finding-id-2"] }
```

The reader also accepts a top-level string array or an object whose `findings` contain objects with `id` fields (including `audit.json`). Missing, unreadable, malformed, or unsupported baseline files currently act as empty baselines.

Configured suppression example:

```json
{
  "suppressions": [
    { "id": "finding-id-1", "file": "src/legacy.ts", "reason": "Intentional compatibility boundary" }
  ]
}
```

All supplied selectors must match exactly. Suppressed findings remain in artifacts with `suppressed: true` and a reason. Audit checks configured suppressions against the entire current finding set, and reports unmatched selectors as introduced `stale_suppression` warnings. Saved baseline IDs do not get this stale-suppression check.

The lens does not implement a general inline suppression-comment syntax. Upstream tools may honor their own directives. Suggested artifact actions describe remediation; `audit` does not apply fixes or edit the config.
