/**
 * Types for the `openclaw selftest --json` customer-truth self-check.
 *
 * The JSON object printed by the selftest is consumed by the agent-runtime-ops
 * operator tool (domain/selftest_contract.py:run_image_selftest_contract). The
 * shape here MUST stay in sync with that parser: an object with `checks` (each
 * `{name, ok, detail, severity}`) and `required_checks`. opsctl gates the rollout
 * on every `required` check passing.
 */
export type SelfTestSeverity = "required" | "advisory";

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
  severity: SelfTestSeverity;
}

export interface SelfTestResult {
  ok: boolean;
  contract: string;
  ts: number;
  durationMs: number;
  checks: SelfTestCheck[];
  required_checks: string[];
}
