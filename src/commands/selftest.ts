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
 *   - selftest_gateway_ready_ok    GET /readyz on 127.0.0.1:18789 -> 200 (gateway up + ready)
 *   - selftest_model_roundtrip_ok  real one-shot completion via the local model transport
 *                                  (the customer's configured provider + credentials)
 *   - selftest_nas_access_ok       the NAS docs mount is readable from inside the container
 *
 * These use only what the gateway container natively has: the gateway readiness HTTP probe,
 * the product's own local model-completion path (reused from `infer model run`), and the
 * bind-mounted NAS directory. No opt-in gateway HTTP endpoint and no WebSocket dependency.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SelfTestCheck, SelfTestResult } from "./selftest.types.js";

const CONTRACT_NAME = "openclaw-selftest-v1";
const REQUIRED_CHECKS = [
  "selftest_gateway_ready_ok",
  "selftest_model_roundtrip_ok",
  "selftest_nas_access_ok",
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
  // Real one-shot model completion through the LOCAL transport — the customer's own
  // configured provider + credentials produce a completion. Reuses the exact tested
  // `runModelRun` path (no opt-in gateway HTTP endpoint, no WebSocket dependency). The
  // gateway's own model path is covered separately by the gateway-readiness check.
  try {
    const { runLocalModelCompletion } = await import("../cli/capability-cli.js");
    const result = await Promise.race([
      runLocalModelCompletion("Reply with exactly: OK"),
      new Promise<{ ok: false; text: string; detail: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, text: "", detail: "timeout" }), timeoutMs),
      ),
    ]);
    if (!result.ok) {
      return required("selftest_model_roundtrip_ok", false, `model=${result.detail} ${redact(result.text || "no completion")}`);
    }
    const replied = /\bOK\b/.test(result.text);
    return required(
      "selftest_model_roundtrip_ok",
      replied,
      replied ? `model=${result.detail} completed` : `model=${result.detail} no OK token`,
    );
  } catch (err) {
    return required("selftest_model_roundtrip_ok", false, redact(err));
  }
}

async function checkNasAccess(): Promise<SelfTestCheck> {
  // Verify the customer's NAS is mounted and readable from inside the container (the
  // executor's data path). opsctl separately confirms it is a real mount (findmnt); here
  // we prove the gateway runtime can actually list it.
  const dir = process.env.OPENCLAW_NAS_DOCS_DIR || join(process.env.HOME || "/home/node", "nas_docs");
  try {
    const entries = await fs.readdir(dir);
    return required("selftest_nas_access_ok", true, `nas dir=${dir} entries=${entries.length}`);
  } catch (err) {
    return required("selftest_nas_access_ok", false, `nas dir=${dir} ${redact(err)}`);
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
  checks.push(await checkNasAccess());
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
