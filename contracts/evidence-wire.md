# Cross-lens evidence vocabulary v1

Native envelopes may carry an additive `evidence_contract` array. All consumers validate the array before using its enclosing artifact. Omission preserves legacy native envelopes; null/malformed extensions are rejected. This does not replace native freshness checks or assert that all producers already emit the common vocabulary.

Each entry has `schema_version: 1` and a discriminant `kind`:
- `run`: id; analyzer `{name, version}`; ruleset; config/input fingerprints; declared language profile; producer `{name, version}` array. Strings must be nonempty.
- `finding`: id; namespaced rule_id; semantic subject; run_id; locations `{file, line}`; evidence_kind (diagnostic/test/metric/heuristic/semantic/tool-rule); confidence (high/medium/low); severity (error/warning/note); disposition (block/warn/review/info); message; explicit null or `{reason}` suppression. Lines are positive safe integers.
- `measurement`: name; finite value or explicit null with limitations; unit; scope; model; run_id; explicit null or ordered finite `{lower,upper}` uncertainty; limitations array. Missing observation cannot silently become zero.
- `comparison`: compatible/incompatible/unknown status; current_run; baseline_run or explicit null; reasons. Compatible requires both runs and no incomparability reasons. Other states require reasons. Structural validation does not establish compatibility: native comparison must verify versions, scope and environment first.

Capability records remain specified by `capability-cases.json`. `wire-cases.json` supplies positive cases, missing-field mutations, malformed scopes, absent provenance, invalid intervals and suppressed findings. Native TypeScript discriminated types and Rust serde variants validate the same corpus; the native artifact readers consume their validators.

`reporting-cases.json` checks that impact and disposition remain distinct and waived findings remain visible in SARIF. TS now exports audit SARIF through `audit --format sarif`; QML exports accepted suppressions; Rust policy and export share disposition/waivability interpretation. Operational failures are not ordinary suppressible diagnostics.

Native writers now attach run, finding and numeric-summary measurement projections to artifacts with a native run identity. Each producer invocation has its own run ID (distinct from the reusable analysis fingerprint), and native readers validate local references, unique identities and agreement with the native payload. Capability evaluated/skipped counts are explicitly **invocation counts**, not rule/file coverage. Disabled and unavailable producers cannot claim completed capability evidence. Legacy envelopes without run identity remain structurally readable; this is not current-source verification.

Summary units not explicitly standardized are `producer-defined`, with formula/interpretation limitations; these must not be treated as interchangeable measurements. Producer version entries are the declared integration inventory, not proof those tools executed; capabilities carry execution state.

Native audits now project comparison outcomes with explicit linked baseline runs; no requested/available baseline remains unknown. Saved audit generation references bind each consumed producer's bytes, run ID and semantic digest. Required verification rejects legacy envelopes even though diagnostic consumers can still read them. Critical compiler/lint/React/test/package/imported/coverage payloads are checked independently of wire shape.

`rule_applicability` is a separate native extension: managed rule/file dispatch counts and bounded upstream-family invocation counts, with evaluated/skipped/abstained scope and limitations. It does not redefine shared capability counts or claim per-expression semantic resolution. Current TS/QML fixture and real-output validation is recorded in `../acceptance/trust-followup.md`.

Still open: exhaustive rule-family semantics/contracts, every reporter/profile combination and native fault payload, imported source/environment authenticity, and immutable multi-read generation pinning. Local projection/digest validation is not cryptographic authenticity or a universal whole-run freshness guarantee.
