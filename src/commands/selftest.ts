/**
 * `openclaw selftest --json` — product-attested customer-truth self-check.
 *
 * The OpenClaw product attests to its own customer truth from INSIDE the running
 * container (it owns the gateway, the model path, and the executor/NAS tool path),
 * instead of the operator tool reimplementing product probing. The agent-runtime-ops
 * wrapper image declares a selftest contract; opsctl verifies the attested contract via
 * wrapper-label/recipe digests, runs this command via `docker exec`, parses the JSON
 * below, and gates the rollout on the `required` checks.
 *
 * Required checks (all must pass for a customer rollout to proceed):
 *   - selftest_gateway_ready_ok          GET  /readyz       -> 200 (gateway up + ready)
 *   - selftest_model_roundtrip_ok        POST /v1/responses -> a real model completion
 *   - selftest_executor_nas_roundtrip_ok POST runner /runner/runs -> real nas.list via executor
 *
 * All three talk to localhost services the gateway container can reach:
 *   - the gateway HTTP surface on 18789 (the openclaw-gateway-http-18789 contract). The
 *     model round-trip uses the synchronous OpenResponses endpoint (the same path the
 *     runner uses); sessions.send is not used because it streams the reply asynchronously.
 *   - the runner (OPENCLAW_RUNNER_BASE_URL, default :8006), which mints the executor
 *     session and drives the real gateway -> nas-executor-tools -> executor -> broker chain.
 */
import type { SelfTestCheck, SelfTestResult } from "./selftest.types.js";

const CONTRACT_NAME = "openclaw-selftest-v1";
const REQUIRED_CHECKS = [
  "selftest_gateway_ready_ok",
  "selftest_model_roundtrip_ok",
  "selftest_executor_nas_roundtrip_ok",
] as const;

// Container-internal gateway HTTP surface (the openclaw-gateway-http-18789 contract).
const GATEWAY_ORIGIN = "http://127.0.0.1:18789";

/** Never let a token/secret-looking blob reach the JSON detail field. */
function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/[A-Za-z0-9._-]{24,}/g, "<redacted>").split("\n", 1)[0]!.slice(0, 200);
}

function required(name: string, ok: boolean, detail: string): SelfTestCheck {
  return { name, ok, detail, severity: "required" };
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkGatewayReady(timeoutMs: number): Promise<SelfTestCheck> {
  try {
    const res = await withTimeout(timeoutMs, (signal) =>
      fetch(`${GATEWAY_ORIGIN}/readyz`, { signal }),
    );
    return required("selftest_gateway_ready_ok", res.ok, `readyz status=${res.status}`);
  } catch (err) {
    return required("selftest_gateway_ready_ok", false, redact(err));
  }
}

async function checkModelRoundtrip(timeoutMs: number): Promise<SelfTestCheck> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    const res = await withTimeout(timeoutMs, (signal) =>
      fetch(`${GATEWAY_ORIGIN}/v1/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "openclaw", input: "Reply with exactly: OK", stream: false }),
        signal,
      }),
    );
    if (!res.ok) {
      return required("selftest_model_roundtrip_ok", false, `responses status=${res.status}`);
    }
    const replied = /\bOK\b/.test(await res.text());
    return required(
      "selftest_model_roundtrip_ok",
      replied,
      replied ? "model completed" : "no OK token in completion",
    );
  } catch (err) {
    return required("selftest_model_roundtrip_ok", false, redact(err));
  }
}

async function checkExecutorNasRoundtrip(timeoutMs: number): Promise<SelfTestCheck> {
  // The executor session is minted by the runner; we drive the real chain and inspect
  // its tool audit rather than calling the executor directly (no in-repo executor client).
  const base = (process.env.OPENCLAW_RUNNER_BASE_URL || "http://127.0.0.1:8006").replace(/\/$/, "");
  const token = process.env.OPENCLAW_RUNNER_INTERNAL_TOKEN || "";
  const mbId = process.env.OPENCLAW_SELFTEST_MB_ID || "system_selftest";
  const grants = (process.env.OPENCLAW_SELFTEST_GRANTS || "*")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers["x-openclaw-runner-token"] = token;
  }
  try {
    const res = await withTimeout(timeoutMs, (signal) =>
      fetch(`${base}/runner/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          request_id: `selftest_${Date.now()}`,
          mb_id: mbId,
          authoritative_grants: grants,
          prompt: "List the root NAS directory to verify NAS access.",
        }),
        signal,
      }),
    );
    if (!res.ok) {
      return required("selftest_executor_nas_roundtrip_ok", false, `runner status=${res.status}`);
    }
    const data = (await res.json()) as { tool_audit?: { ok?: boolean; tool_call_count?: number } };
    const audit = data.tool_audit ?? {};
    const calls = Number(audit.tool_call_count ?? 0);
    const ok = audit.ok !== false && calls > 0;
    return required("selftest_executor_nas_roundtrip_ok", ok, `tool_calls=${calls} ok=${audit.ok ?? "n/a"}`);
  } catch (err) {
    return required("selftest_executor_nas_roundtrip_ok", false, redact(err));
  }
}

export interface SelftestOptions {
  json?: boolean;
  timeoutMs?: number;
}

export async function runSelftest(opts: SelftestOptions = {}): Promise<SelfTestResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
  const checks: SelfTestCheck[] = [];
  checks.push(await checkGatewayReady(Math.min(timeoutMs, 10_000)));
  checks.push(await checkModelRoundtrip(timeoutMs));
  checks.push(await checkExecutorNasRoundtrip(timeoutMs));
  const ok = checks.filter((c) => c.severity === "required").every((c) => c.ok);
  return {
    ok,
    contract: CONTRACT_NAME,
    ts: start,
    durationMs: Date.now() - start,
    checks,
    required_checks: [...REQUIRED_CHECKS],
  };
}

/**
 * CLI entry. Prints ONLY the JSON result on stdout (so opsctl can parse it) and exits
 * 0 iff every required check passed.
 */
export async function selftestCommand(opts: SelftestOptions = {}): Promise<void> {
  const result = await runSelftest(opts);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
