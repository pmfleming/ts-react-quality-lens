# Trust follow-up: five implementation stages

Authority remains `criteria.json`; implementation is not automatic acceptance closure.
The previous 2093909 repeatability campaign is historical for changed semantics.

## Stage 1 — bounded rule applicability

- Added per-rule evaluated/skipped/abstained file counts for every managed typed/React blocker, including classic-profile exclusions. Successful parser/rule dispatch is required for an evaluated negative; parser failures and missing file results abstain.
- Added explicit selected/unavailable/not-applicable execution counts for all eight bounded upstream families. Compiler remains selected, not silently inapplicable. These are **family invocation** counts, not invented per-upstream-rule semantic counts.
- Managed React execution now uses the version actually recorded by the lens, rather than an arbitrary project plugin version.
- Added a mutation-tested closed blocking-inventory gate. Existing typed positive/negative/unavailable tests now assert actual dispatch counts; JavaScript-only scope is a not-applicable control.
- New cross-lens profile: `node dist/scripts/cross-lens-check.js ../qmlqualitylens`. Both native validators accept/reject both repositories' shared wire/capability fixtures (380 assertions), QML revision `fdd92bcc096c3acfc3ef5bab564776b34b84657e`.

Validation: `npm run ci` passed **80 tests**, schema/inventory/format checks, performance and installed-package smoke on Linux Node 24.16.0/npm 11.13.0. Cross-lens profile passed.

Scope limitation: file dispatch is not proof that every expression's semantics resolved. Exhaustive upstream diagnostic-family producer cases and per-expression abstention remain T3/E2 obligations. No criterion is promoted on the strength of dispatch counts alone.
