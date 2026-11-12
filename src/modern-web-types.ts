/** Modernization candidates are advisory even when browser support is established. */
export type ModernWebConfig = {
  enabled?: boolean;
  roots?: string[];
  exclude?: string[];
  timeout_ms?: number;
  max_output_bytes?: number;
  browsers?: { targets?: string[]; environment?: string };
};

export type ModernWebSettings = {
  enabled: boolean;
  roots: string[];
  exclude: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  browsers: { targets: string[] | null; environment: string };
};

export type ModernWebCandidate = {
  rule_id: string;
  guide_id: string;
  summary: string;
  file: string;
  line: number;
  message: string;
  line_content: string;
  verification: { keepWhen: string[]; dropWhen: string[] } | null;
};

export type ModernWebExecution = {
  status: "disabled" | "unavailable" | "failed" | "succeeded";
  available: boolean;
  ran: boolean;
  complete: boolean;
  reason: string | null;
  version: string | null;
  duration_ms: number;
  candidates: ModernWebCandidate[];
  active_rules: number | null;
  active_guides: number | null;
  coverage: "not_run" | "unknown";
  limitations: string[];
};

export type BrowserTargets = {
  status: "resolved" | "unknown";
  workspace: string;
  source: string | null;
  environment: string;
  queries: string[];
  resolved: string[];
  reason: string | null;
  config_files: string[];
};

export type ModernWebCompatibility = {
  status: "supported" | "fallback_required" | "incompatible" | "unknown";
  feature_ids: string[];
  unsupported_targets: string[];
  unknown_targets: string[];
  reason: string;
  remediation: "review_replacement" | "review_fallback" | "withheld";
  guard: "observed" | "not_observed" | "not_assessed";
};
