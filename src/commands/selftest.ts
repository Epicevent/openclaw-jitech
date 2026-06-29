/**
 * `openclaw selftest --json` — product-attested customer-truth self-check.
 *
 * The OpenClaw product attests to its own customer truth from INSIDE the running
 * container (it owns the gateway client, sessions, and the executor/NAS tool path),
 * instead of the operator tool reimplementing product probing. The agent-runtime-ops
 * wrapper image declares a selftest contract (recipes/runtime/openclaw-control.yaml);
 * opsctl verifies the attested contract via wrapper-label/recipe digests and then runs
 * this command via `docker exec`, parses the JSON below, and gates the rollout on the
 * `required` checks.
 *
 * Required checks (must all pass for a customer rollout to proceed):
 *   - selftest_gateway_ready_ok          gateway answers (RPC reachable)
 *   - selftest_model_roundtrip_ok        a real model turn returns a reply
 *   - selftest_executor_nas_roundtrip_ok a real nas.list runs through the runner -> executor -> broker
 *
 * NAS path: the executor session key is minted by the runner (POST /runner/runs), which
 * drives the real customer chain. The product src has no in-repo executor client (the
 * nas-executor-tools plugin lives in the openclaw-executor repo), so the NAS round-trip
 * is exercised by asking the runner to do it and inspecting its tool audit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERIFICATION REQUIRED (could not be compiled/linted/tested where this was authored):
 *   - tsgo:core type-check + the repo lint suite (host-env-policy for process.env reads,
 *     no-raw-fetch may require a sanctioned http helper instead of global fetch).
 *   - Confirm gateway method names + return shapes used below against the live gateway:
 *       * "health" (readiness), "sessions.create" (returns key|sessionKey),
 *         "sessions.send" ({ key, message }).
 *   - Confirm the runner contract: POST {OPENCLAW_RUNNER_BASE_URL}/runner/runs with
 *     { request_id, mb_id, authoritative_grants, prompt } and the tool_audit response shape
 *     (openclaw-executor/runner/main.py).
 * Adjust the call sites flagged with `VERIFY:` once confirmed.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { callGateway } from "../gateway/call.js";
import type { SelfTestCheck, SelfTestResult } from "./selftest.types.js";

const CONTRACT_NAME = "openclaw-selftest-v1";
const REQUIRED_CHECKS = [
  "selftest_gateway_ready_ok",
  "selftest_model_roundtrip_ok",
  "selftest_executor_nas_roundtrip_ok",
] as const;

/** Never let a token/secret-looking blob reach the JSON detail field. */
function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/[A-Za-z0-9._-]{24,}/g, "<redacted>").split("\n", 1)[0]!.slice(0, 200);
}

function required(name: string, ok: boolean, detail: string): SelfTestCheck {
  return { name, ok, detail, severity: "required" };
}

async function checkGatewayReady(timeoutMs: number): Promise<SelfTestCheck> {
  try {
    // VERIFY: method name "health" + that a non-throwing response means ready.
    await callGateway({ method: "health", params: {}, timeoutMs });
    return required("selftest_gateway_ready_ok", true, "gateway answered");
  } catch (err) {
    return required("selftest_gateway_ready_ok", false, redact(err));
  }
}

async function checkModelRoundtrip(timeoutMs: number): Promise<SelfTestCheck> {
  try {
    // VERIFY: sessions.create params + return key field (key vs sessionKey).
    const created = await callGateway<{ key?: string; sessionKey?: string }>({
      method: "sessions.create",
      params: {},
      timeoutMs,
    });
    const sessionKey = created.key ?? created.sessionKey;
    if (!sessionKey) {
      return required("selftest_model_roundtrip_ok", false, "sessions.create returned no session key");
    }
    // VERIFY: sessions.send params { key, message } + that the reply text is in the result.
    const sent = await callGateway<Record<string, unknown>>({
      method: "sessions.send",
      params: { key: sessionKey, message: "Reply with exactly: OK" },
      timeoutMs,
    });
    const replied = /\bOK\b/.test(JSON.stringify(sent));
    return required(
      "selftest_model_roundtrip_ok",
      replied,
      replied ? "model replied" : "no OK token in model reply",
    );
  } catch (err) {
    return required("selftest_model_roundtrip_ok", false, redact(err));
  }
}

async function checkExecutorNasRoundtrip(timeoutMs: number): Promise<SelfTestCheck> {
  // VERIFY: env keys + host-env-policy. The executor session is minted by the runner;
  // we drive the real chain and inspect its tool audit rather than calling the executor directly.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // VERIFY: runner endpoint path + request/response contract (openclaw-executor/runner/main.py).
    const res = await fetch(`${base}/runner/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        request_id: `selftest_${Date.now()}`,
        mb_id: mbId,
        authoritative_grants: grants,
        prompt: "List the root NAS directory to verify NAS access.",
      }),
      signal: controller.signal,
    });
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
  } finally {
    clearTimeout(timer);
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
