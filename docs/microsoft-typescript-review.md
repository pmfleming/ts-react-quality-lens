# Microsoft TypeScript guidance comparison

Reviewed against the implemented lens on 2026-11-12. Each section records the comparison, implemented improvements, and remaining boundaries. Guidance informs evidence; design preferences are not universal correctness gates.

## 1. Handbook: More on Functions

Source: [More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html).

Existing coverage: compiler signature diagnostics, unsafe `any` operations, unnecessary type parameters, and explicit return-only generic candidates. Missing coverage: broad `Function` annotations and overloads that can share a signature.

Implemented: managed `no-unsafe-function-type` warnings and advisory `unified-signatures`. Overloads with different return contracts remain distinct; differently named parameters or JSDoc are conservatively preserved. Both rules use the existing evaluated-file inventory, versioned ruleset, and unavailable-evidence behavior. Positive/negative fixtures exercise real managed lint. No automatic overload rewriting or blanket return-annotation requirement is introduced.

## 2. TSConfig Reference

Source: [TSConfig Reference](https://www.typescriptlang.org/tsconfig/).

Existing coverage: parsed inherited settings, diagnostics, and strict-profile posture. Gaps: boolean OR incorrectly erased explicit false overrides; omitted defaults appeared disabled; only the first workspace's options informed posture.

Implemented: analysis-compiler-aware defaults, independent strict-family values, per-tsconfig option inventories and findings, and solution-config exclusion. Explicitly enabling the whole strict family satisfies the baseline even without the umbrella flag. Unavailable configurations remain unknown. Build constraints (`verbatimModuleSyntax`, `erasableSyntaxOnly`) are no longer universal strictness requirements; environment-specific review belongs to the modules stage. Tests cover inherited overrides, distinct workspace policies, defaults and unavailable configs.
