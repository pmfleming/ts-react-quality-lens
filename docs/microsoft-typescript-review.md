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

## 3. Modules: Choosing Compiler Options

Source: [Choosing Compiler Options](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html).

Existing coverage: compiler import resolution, package diagnostics, and source/framework boundaries. Gap: no declared runtime context for compiler recommendations.

Implemented: optional per-tsconfig Node/bundler/unbundled-browser/library declarations, compiler-computed module defaults, and advisory reviews for resolution, independent transpilation, duplicate emit, library declarations/output placement and runtime floor. Unconfigured contexts are unknown; undiscovered/unloaded target configs are unavailable. No package-format, browser-version, bundler execution or external declaration-pipeline claims are made. Library bundling remains a review because emitted JavaScript and declarations can have different compatibility constraints.

## 4. Declaration Files: Do’s and Don’ts

Source: [Declaration Do’s and Don’ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html).

Existing coverage: boxed types, unsafe `any`, generic relationships, overload consolidation, declarations/package checks. Gap: callback signatures were not compared with their implementation usage.

Implemented: advisory public source-contract reviews when every observed direct invocation discards an `any` callback result, or always supplies a non-undefined optional callback argument. Exported functions, arrows and public class methods are supported. Symbol resolution avoids shadowed callbacks; escapes, reassignments, spread calls, unknown arguments and declaration-only APIs cause abstention. Findings include observed call locations. These bounded observations cannot establish safe consumer-facing signature changes, so they never block or auto-edit declarations.

## 5. TypeScript Performance

Source: [TypeScript Performance](https://github.com/microsoft/TypeScript/wiki/Performance).

Existing coverage: structural type-complexity metrics, lens benchmarks, cached analysis and compiler provenance. Gap: neither structural size nor lint duration measures compiler work or explains the compiler's input scope.

Implemented: opt-in compiler API phase observations, guarded compiler counters, per-project file inventories, source/declaration/default-library/external-library counts, and original timestamps/identities for cached samples. Unexpected source inclusion can be inspected directly. Unknown counters remain null; unavailable projects remain incomplete. Measurements describe this analysis compiler, not native builds, editor responsiveness or individual expensive types. No blanket interface rewrite, skipLibCheck recommendation, timing gate or statistically unsupported regression claim is added. Deeper investigation still calls for compiler traces or repeated controlled builds.
